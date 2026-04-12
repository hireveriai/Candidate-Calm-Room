create or replace function public.build_follow_up_question(p_last_answer text)
returns text
language sql
stable
as $$
  select public.build_follow_up_question($1, null, null, null, false);
$$;

create or replace function public.build_follow_up_question(
  p_last_answer text,
  p_last_question text,
  p_skill_name text,
  p_probe_type text,
  p_is_contradiction boolean
)
returns text
language plpgsql
as $$
declare
  v_answer text := nullif(trim(coalesce(p_last_answer, '')), '');
  v_skill text := nullif(trim(coalesce(p_skill_name, '')), '');
  v_probe text := lower(coalesce(p_probe_type, ''));
begin
  if v_answer is null then
    return 'Can you give one concrete example from your recent work and explain the result?';
  end if;

  if p_is_contradiction then
    return 'Help me reconcile that answer with what you said earlier. What exactly did you do yourself, what tools did you use, and what measurable result came from it?';
  end if;

  if v_probe = 'clarify' then
    return 'Break that down step by step. What was the problem, what did you do, and what was the result?';
  elsif v_probe = 'tools' then
    return format(
      'Which tools, technologies, or frameworks did you use%s, and why did you choose them?',
      case when v_skill is not null then format(' for %s', v_skill) else '' end
    );
  elsif v_probe = 'numbers' then
    return 'What numbers or metrics best show the impact of that work?';
  elsif v_probe = 'deeper' then
    return format(
      'What was the hardest technical decision there%s, and what trade-offs did you consider?',
      case when v_skill is not null then format(' around %s', v_skill) else '' end
    );
  end if;

  return format(
    'Walk me through one specific example, your exact role%s, the tools you used, and the outcome.',
    case when v_skill is not null then format(' related to %s', v_skill) else '' end
  );
end;
$$;

create or replace function public.get_effective_question_count(p_interview_id uuid)
returns integer
language plpgsql
as $$
declare
  v_configured_count integer := 0;
  v_duration integer := public.get_effective_duration_minutes(p_interview_id);
  v_planned_count integer := 0;
  v_duration_target integer := 9;
  v_effective_count integer := 1;
begin
  select coalesce(i.question_count, 0)
  into v_configured_count
  from public.interviews i
  where i.interview_id = p_interview_id;

  select count(*)
  into v_planned_count
  from public.interview_questions iq
  where iq.interview_id = p_interview_id;

  v_duration_target := case
    when v_duration >= 60 then 17
    when v_duration >= 45 then 13
    when v_duration >= 30 then 9
    when v_duration >= 20 then 7
    when v_duration >= 15 then 5
    when v_duration >= 10 then 4
    else 3
  end;

  v_effective_count := greatest(v_duration_target, v_configured_count, v_planned_count, 1);
  return v_effective_count;
end;
$$;

create or replace function public.get_current_phase(
  p_started_at timestamptz,
  p_duration_minutes integer
)
returns text
language plpgsql
as $$
declare
  v_ratio numeric;
begin
  if p_started_at is null then
    return 'warmup';
  end if;

  v_ratio := greatest(
    0,
    extract(epoch from (now() - p_started_at)) / greatest(coalesce(p_duration_minutes, 30) * 60, 1)
  );

  if v_ratio <= 0.15 then
    return 'warmup';
  elsif v_ratio <= 0.65 then
    return 'core';
  elsif v_ratio <= 0.90 then
    return 'probe';
  else
    return 'closing';
  end if;
end;
$$;

create or replace function public.get_initial_difficulty_level(
  p_interview_id uuid,
  p_candidate_experience text default null
)
returns integer
language plpgsql
as $$
declare
  v_years integer;
  v_experience text := lower(coalesce(p_candidate_experience, ''));
begin
  select cra.claimed_experience_years
  into v_years
  from public.candidate_resume_ai cra
  where cra.interview_id = p_interview_id
  order by cra.created_at desc nulls last
  limit 1;

  if v_experience in ('fresher', 'entry', 'junior', 'low') or coalesce(v_years, 0) <= 1 then
    return 2;
  elsif v_experience in ('senior', 'lead', 'staff', 'principal', 'high') or coalesce(v_years, 0) >= 6 then
    return 4;
  else
    return 3;
  end if;
end;
$$;

create or replace function public.start_interview_session(p_token text)
returns table (
  attempt_id uuid,
  interview_id uuid,
  attempt_number integer,
  reused boolean
)
language plpgsql
as $$
declare
  v_invite public.interview_invites%rowtype;
  v_latest_attempt public.interview_attempts%rowtype;
  v_interview public.interviews%rowtype;
  v_attempts_used integer;
  v_max_attempts integer;
  v_initial_difficulty integer;
begin
  if nullif(trim(coalesce(p_token, '')), '') is null then
    raise exception 'token is required';
  end if;

  select *
  into v_invite
  from public.interview_invites
  where token = trim(p_token)
  for update;

  if not found then
    raise exception 'Invite not found';
  end if;

  if v_invite.status is not null and v_invite.status <> 'ACTIVE' then
    raise exception 'Invite is not active';
  end if;

  if v_invite.expires_at is not null and v_invite.expires_at <= now() then
    raise exception 'Invite has expired';
  end if;

  select *
  into v_interview
  from public.interviews
  where interview_id = v_invite.interview_id;

  if not found then
    raise exception 'Interview not found';
  end if;

  select *
  into v_latest_attempt
  from public.interview_attempts
  where interview_id = v_invite.interview_id
  order by attempt_number desc, started_at desc
  limit 1;

  if found and lower(coalesce(v_latest_attempt.status, '')) = 'started' then
    return query
    select v_latest_attempt.attempt_id, v_latest_attempt.interview_id, v_latest_attempt.attempt_number, true;
    return;
  end if;

  v_attempts_used := coalesce(v_invite.attempts_used, 0);
  v_max_attempts := coalesce(v_invite.max_attempts, coalesce(v_interview.max_attempts, 1), 1);

  if v_attempts_used >= v_max_attempts then
    raise exception 'Maximum attempts reached for this invite';
  end if;

  v_initial_difficulty := public.get_initial_difficulty_level(v_interview.interview_id, null);

  insert into public.interview_attempts (
    interview_id,
    attempt_number,
    status,
    current_phase,
    difficulty_level,
    adaptive_state
  )
  values (
    v_invite.interview_id,
    coalesce(v_latest_attempt.attempt_number, 0) + 1,
    'started',
    'warmup',
    v_initial_difficulty,
    jsonb_build_object(
      'current_phase', 'warmup',
      'time_elapsed_seconds', 0,
      'questions_asked', 0,
      'skills_covered', 0,
      'last_answer_score', null,
      'difficulty_level', v_initial_difficulty,
      'duration_minutes', public.get_effective_duration_minutes(v_invite.interview_id)
    )
  )
  returning public.interview_attempts.attempt_id, public.interview_attempts.interview_id, public.interview_attempts.attempt_number
  into attempt_id, interview_id, attempt_number;

  update public.interview_invites
  set attempts_used = coalesce(attempts_used, 0) + 1,
      used_at = now()
  where invite_id = v_invite.invite_id;

  reused := false;
  return next;
end;
$$;

create or replace function public.get_first_interview_question(p_attempt_id uuid)
returns table (
  session_question_id uuid,
  question_id uuid,
  content text,
  source text,
  question_kind text,
  question_order integer,
  asked_at timestamptz
)
language plpgsql
as $$
declare
  v_attempt public.interview_attempts%rowtype;
  v_effective_phase text;
  v_duration integer;
  v_first record;
begin
  if p_attempt_id is null then
    raise exception 'attempt_id is required';
  end if;

  select * into v_attempt from public.interview_attempts where attempt_id = p_attempt_id;
  if not found then
    raise exception 'Interview attempt not found';
  end if;

  select sq.session_question_id, sq.question_id, sq.content, sq.source, sq.question_kind, sq.question_order, sq.asked_at
  into session_question_id, question_id, content, source, question_kind, question_order, asked_at
  from public.session_questions sq
  where sq.attempt_id = p_attempt_id
  order by sq.question_order asc, sq.asked_at asc nulls last
  limit 1;

  if found then
    return next;
    return;
  end if;

  v_duration := public.get_effective_duration_minutes(v_attempt.interview_id);
  v_effective_phase := public.get_current_phase(v_attempt.started_at, v_duration);

  select iq.question_id,
         coalesce(iq.question_text, q.question_text) as content,
         coalesce(iq.target_skill_id, qsm.skill_id) as mapped_skill_id,
         iq.source_type,
         iq.reference_context,
         iq.difficulty_level
  into v_first
  from public.interview_questions iq
  left join public.questions q on q.question_id = iq.question_id and q.is_active = true
  left join public.question_skill_map qsm on qsm.question_id = iq.question_id
  where iq.interview_id = v_attempt.interview_id
  order by case when coalesce(iq.phase_hint, 'core') = 'warmup' then 0 else 1 end,
           iq.question_order asc
  limit 1;

  insert into public.session_questions (
    attempt_id, question_id, content, source, question_kind, question_order,
    source_context, mapped_skill_id, phase, difficulty_level
  )
  values (
    p_attempt_id,
    v_first.question_id,
    coalesce(v_first.content, 'Tell me about your experience and the work most relevant to this role.'),
    'system',
    'core',
    1,
    jsonb_build_object(
      'source_type', coalesce(v_first.source_type, 'unknown'),
      'reference_context', coalesce(v_first.reference_context, '{}'::jsonb)
    ),
    v_first.mapped_skill_id,
    v_effective_phase,
    coalesce(v_first.difficulty_level, v_attempt.difficulty_level, 3)
  )
  returning public.session_questions.session_question_id, public.session_questions.question_id, public.session_questions.content,
            public.session_questions.source, public.session_questions.question_kind,
            public.session_questions.question_order, public.session_questions.asked_at
  into session_question_id, question_id, content, source, question_kind, question_order, asked_at;

  perform public.sync_attempt_adaptive_state(p_attempt_id, v_effective_phase, coalesce(v_attempt.difficulty_level, 3), null);
  return next;
end;
$$;

create or replace function public.submit_interview_answer(
  p_session_question_id uuid,
  p_transcript text,
  p_duration_seconds integer default null,
  p_signals jsonb default null
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
  v_payload jsonb;
begin
  if p_session_question_id is null then
    raise exception 'session_question_id is required';
  end if;

  select * into v_session_question
  from public.session_questions
  where public.session_questions.session_question_id = p_session_question_id;

  if not found then
    raise exception 'Session question not found';
  end if;

  v_payload := jsonb_strip_nulls(
    jsonb_build_object(
      'duration', p_duration_seconds,
      'signals', coalesce(p_signals, '{}'::jsonb)
    )
  );

  update public.interview_answers
  set answer_text = nullif(trim(coalesce(p_transcript, '')), ''),
      answer_payload = coalesce(public.interview_answers.answer_payload, '{}'::jsonb) || v_payload,
      answered_at = now()
  where public.interview_answers.session_question_id = p_session_question_id
  returning public.interview_answers.answer_id, public.interview_answers.attempt_id, public.interview_answers.question_id,
            public.interview_answers.session_question_id, public.interview_answers.answer_text,
            public.interview_answers.answer_payload, public.interview_answers.answered_at
  into answer_id, attempt_id, question_id, session_question_id, answer_text, answer_payload, answered_at;

  if answer_id is null then
    insert into public.interview_answers (
      attempt_id, question_id, answer_text, answer_payload, session_question_id
    )
    values (
      v_session_question.attempt_id,
      v_session_question.question_id,
      nullif(trim(coalesce(p_transcript, '')), ''),
      v_payload,
      p_session_question_id
    )
    returning public.interview_answers.answer_id, public.interview_answers.attempt_id, public.interview_answers.question_id,
              public.interview_answers.session_question_id, public.interview_answers.answer_text,
              public.interview_answers.answer_payload, public.interview_answers.answered_at
    into answer_id, attempt_id, question_id, session_question_id, answer_text, answer_payload, answered_at;
  end if;

  return next;
end;
$$;

grant all on function public.build_follow_up_question(text) to anon, authenticated, service_role;
grant all on function public.build_follow_up_question(text, text, text, text, boolean) to anon, authenticated, service_role;
grant all on function public.get_effective_question_count(uuid) to anon, authenticated, service_role;
grant all on function public.get_current_phase(timestamptz, integer) to anon, authenticated, service_role;
grant all on function public.get_initial_difficulty_level(uuid, text) to anon, authenticated, service_role;
grant all on function public.start_interview_session(text) to anon, authenticated, service_role;
grant all on function public.get_first_interview_question(uuid) to anon, authenticated, service_role;
grant all on function public.submit_interview_answer(uuid, text, integer, jsonb) to anon, authenticated, service_role;
