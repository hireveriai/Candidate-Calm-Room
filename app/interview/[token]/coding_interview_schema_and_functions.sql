begin;

create table if not exists public.interview_code_submissions (
  code_submission_id uuid primary key default gen_random_uuid(),
  answer_id uuid not null unique references public.interview_answers(answer_id) on delete cascade,
  attempt_id uuid not null references public.interview_attempts(attempt_id) on delete cascade,
  session_question_id uuid not null references public.session_questions(session_question_id) on delete cascade,
  question_id uuid null references public.questions(question_id) on delete set null,
  language text not null,
  code_text text not null,
  code_quality_score numeric(5, 2),
  correctness_score numeric(5, 2),
  problem_solving_score numeric(5, 2),
  confidence_score numeric(5, 2),
  fraud_score numeric(5, 2),
  review_summary text,
  review_payload jsonb not null default '{}'::jsonb,
  review_status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_interview_code_submissions_attempt
  on public.interview_code_submissions (attempt_id);

create index if not exists idx_interview_code_submissions_session_question
  on public.interview_code_submissions (session_question_id);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_interview_code_submissions_status'
  ) then
    alter table public.interview_code_submissions
      add constraint chk_interview_code_submissions_status
      check (review_status in ('pending', 'reviewed'));
  end if;
end $$;

create or replace function public.submit_coding_answer(
  p_session_question_id uuid,
  p_code_text text,
  p_language text,
  p_duration_seconds integer default null
)
returns table (
  answer_id uuid,
  attempt_id uuid,
  question_id uuid,
  session_question_id uuid,
  answer_text text,
  answer_payload jsonb,
  answered_at timestamptz
)
language plpgsql
as $$
declare
  v_session_question public.session_questions%rowtype;
  v_answer public.interview_answers%rowtype;
  v_payload jsonb;
begin
  if p_session_question_id is null then
    raise exception 'session_question_id is required';
  end if;

  if nullif(trim(coalesce(p_code_text, '')), '') is null then
    raise exception 'code_text is required';
  end if;

  if nullif(trim(coalesce(p_language, '')), '') is null then
    raise exception 'language is required';
  end if;

  select *
  into v_session_question
  from public.session_questions
  where session_question_id = p_session_question_id;

  if not found then
    raise exception 'Session question not found';
  end if;

  v_payload := jsonb_strip_nulls(
    jsonb_build_object(
      'answer_mode', 'coding',
      'duration', p_duration_seconds,
      'coding_submission',
      jsonb_build_object(
        'language', trim(p_language),
        'submitted_at', now()
      )
    )
  );

  select *
  into v_answer
  from public.interview_answers
  where session_question_id = p_session_question_id
  limit 1;

  if found then
    update public.interview_answers
    set answer_text = format('[Coding submission in %s]', trim(p_language)),
        answer_payload = coalesce(answer_payload, '{}'::jsonb) || v_payload,
        answered_at = now()
    where public.interview_answers.answer_id = v_answer.answer_id
    returning *
    into v_answer;
  else
    insert into public.interview_answers (
      attempt_id,
      question_id,
      answer_text,
      answer_payload,
      session_question_id
    )
    values (
      v_session_question.attempt_id,
      v_session_question.question_id,
      format('[Coding submission in %s]', trim(p_language)),
      v_payload,
      p_session_question_id
    )
    returning *
    into v_answer;
  end if;

  insert into public.interview_code_submissions (
    answer_id,
    attempt_id,
    session_question_id,
    question_id,
    language,
    code_text,
    review_status,
    review_payload,
    updated_at
  )
  values (
    v_answer.answer_id,
    v_answer.attempt_id,
    p_session_question_id,
    v_answer.question_id,
    trim(p_language),
    p_code_text,
    'pending',
    '{}'::jsonb,
    now()
  )
  on conflict (answer_id)
  do update
  set language = excluded.language,
      code_text = excluded.code_text,
      review_status = 'pending',
      review_payload = '{}'::jsonb,
      updated_at = now();

  answer_id := v_answer.answer_id;
  attempt_id := v_answer.attempt_id;
  question_id := v_answer.question_id;
  session_question_id := v_answer.session_question_id;
  answer_text := v_answer.answer_text;
  answer_payload := v_answer.answer_payload;
  answered_at := v_answer.answered_at;

  return next;
end;
$$;

create or replace function public.record_coding_review(
  p_answer_id uuid,
  p_code_quality_score numeric,
  p_correctness_score numeric,
  p_problem_solving_score numeric,
  p_confidence_score numeric,
  p_fraud_score numeric,
  p_review_summary text,
  p_review_payload jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
as $$
declare
  v_submission public.interview_code_submissions%rowtype;
begin
  if p_answer_id is null then
    raise exception 'answer_id is required';
  end if;

  select *
  into v_submission
  from public.interview_code_submissions
  where answer_id = p_answer_id;

  if not found then
    raise exception 'Code submission not found';
  end if;

  update public.interview_code_submissions
  set code_quality_score = round(greatest(0, least(coalesce(p_code_quality_score, 0), 1)) * 100, 2),
      correctness_score = round(greatest(0, least(coalesce(p_correctness_score, 0), 1)) * 100, 2),
      problem_solving_score = round(greatest(0, least(coalesce(p_problem_solving_score, 0), 1)) * 100, 2),
      confidence_score = round(greatest(0, least(coalesce(p_confidence_score, 0), 1)) * 100, 2),
      fraud_score = round(greatest(0, least(coalesce(p_fraud_score, 0), 1)) * 100, 2),
      review_summary = p_review_summary,
      review_payload = coalesce(p_review_payload, '{}'::jsonb),
      review_status = 'reviewed',
      updated_at = now()
  where answer_id = p_answer_id;

  perform public.record_answer_evaluation(
    p_answer_id,
    greatest(0, least(coalesce(p_correctness_score, 0), 1)),
    greatest(0, least(coalesce(p_code_quality_score, 0), 1)),
    greatest(0, least(coalesce(p_problem_solving_score, 0), 1)),
    greatest(0, least(coalesce(p_confidence_score, 0), 1)),
    greatest(0, least(coalesce(p_fraud_score, 0), 1)),
    coalesce(p_review_summary, 'Coding review completed.'),
    null,
    coalesce(p_review_payload, '{}'::jsonb)
  );

  return true;
end;
$$;

commit;
