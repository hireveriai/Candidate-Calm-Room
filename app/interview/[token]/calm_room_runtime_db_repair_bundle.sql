
-- ====================================================================
-- Source: interview_answer_evaluations_columns_patch.sql
-- ====================================================================

begin;

alter table public.interview_answer_evaluations
  add column if not exists skill_id uuid,
  add column if not exists skill_score numeric,
  add column if not exists clarity_score numeric,
  add column if not exists depth_score numeric,
  add column if not exists confidence_score numeric,
  add column if not exists fraud_score numeric,
  add column if not exists evaluation_json jsonb default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'fk_interview_answer_evaluations_skill'
  ) then
    alter table public.interview_answer_evaluations
      add constraint fk_interview_answer_evaluations_skill
      foreign key (skill_id)
      references public.skill_master(skill_id)
      on delete set null;
  end if;
end $$;

create index if not exists idx_interview_answer_evaluations_skill_id
  on public.interview_answer_evaluations (skill_id);

create index if not exists idx_interview_answer_evaluations_answer_ai
  on public.interview_answer_evaluations (answer_id, evaluator_type);

commit;

-- ====================================================================
-- Source: interview_attempts_adaptive_columns_patch.sql
-- ====================================================================

alter table public.interview_attempts
  add column if not exists current_phase text,
  add column if not exists difficulty_level integer,
  add column if not exists adaptive_state jsonb default '{}'::jsonb,
  add column if not exists last_answer_score numeric;

update public.interview_attempts
set current_phase = coalesce(current_phase, 'warmup'),
    difficulty_level = coalesce(difficulty_level, 3),
    adaptive_state = coalesce(adaptive_state, '{}'::jsonb)
where current_phase is null
   or difficulty_level is null
   or adaptive_state is null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_interview_attempts_current_phase'
  ) then
    alter table public.interview_attempts
      add constraint chk_interview_attempts_current_phase
      check (current_phase in ('warmup', 'core', 'probe', 'closing'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_interview_attempts_difficulty_level'
  ) then
    alter table public.interview_attempts
      add constraint chk_interview_attempts_difficulty_level
      check (difficulty_level between 1 and 5);
  end if;
end $$;

-- ====================================================================
-- Source: runtime_missing_functions_patch.sql
-- ====================================================================

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

-- ====================================================================
-- Source: spoken_evaluation_helper_functions_patch.sql
-- ====================================================================

create or replace function public.get_effective_duration_minutes(p_interview_id uuid)
returns integer
language plpgsql
as $$
declare
  v_minutes integer;
begin
  select coalesce(ic.total_duration_minutes, i.duration_minutes, 30)
  into v_minutes
  from public.interviews i
  left join public.interview_configs ic
    on ic.interview_id = i.interview_id
  where i.interview_id = p_interview_id
  limit 1;

  return coalesce(v_minutes, 30);
end;
$$;


create or replace function public.refresh_attempt_skill_scores(p_attempt_id uuid)
returns void
language plpgsql
as $$
begin
  delete from public.attempt_skill_scores
  where attempt_id = p_attempt_id;

  insert into public.attempt_skill_scores (
    attempt_id,
    skill_id,
    normalized_score
  )
  select
    p_attempt_id,
    src.skill_id,
    avg(src.skill_score)
  from (
    select
      coalesce(
        iae.skill_id,
        sq.mapped_skill_id,
        iq.target_skill_id,
        qsm.skill_id
      ) as skill_id,
      iae.skill_score::numeric as skill_score
    from public.interview_answers ia
    join public.interview_attempts iat
      on iat.attempt_id = ia.attempt_id
    left join public.interview_answer_evaluations iae
      on iae.answer_id = ia.answer_id
     and iae.evaluator_type = 'AI'
    left join public.session_questions sq
      on sq.session_question_id = ia.session_question_id
    left join public.interview_questions iq
      on iq.interview_id = iat.interview_id
     and iq.question_id = ia.question_id
    left join public.question_skill_map qsm
      on qsm.question_id = ia.question_id
    where ia.attempt_id = p_attempt_id
      and iae.skill_score is not null
  ) src
  where src.skill_id is not null
  group by src.skill_id;
end;
$$;


create or replace function public.sync_attempt_adaptive_state(
  p_attempt_id uuid,
  p_phase text,
  p_difficulty integer,
  p_last_answer_score numeric default null
)
returns void
language plpgsql
as $$
declare
  v_started_at timestamptz;
  v_interview_id uuid;
  v_duration integer;
  v_questions_asked integer;
  v_skills_covered integer;
begin
  select ia.started_at, ia.interview_id
  into v_started_at, v_interview_id
  from public.interview_attempts ia
  where ia.attempt_id = p_attempt_id;

  if v_interview_id is null then
    return;
  end if;

  select count(*)
  into v_questions_asked
  from public.session_questions
  where attempt_id = p_attempt_id;

  select count(*)
  into v_skills_covered
  from public.attempt_skill_scores
  where attempt_id = p_attempt_id
    and normalized_score is not null;

  v_duration := public.get_effective_duration_minutes(v_interview_id);

  update public.interview_attempts
  set current_phase = p_phase,
      difficulty_level = greatest(1, least(5, coalesce(p_difficulty, 3))),
      last_answer_score = coalesce(p_last_answer_score, last_answer_score),
      adaptive_state = jsonb_build_object(
        'current_phase', p_phase,
        'time_elapsed_seconds', greatest(extract(epoch from (now() - v_started_at))::integer, 0),
        'questions_asked', v_questions_asked,
        'skills_covered', v_skills_covered,
        'last_answer_score', coalesce(p_last_answer_score, last_answer_score),
        'difficulty_level', greatest(1, least(5, coalesce(p_difficulty, 3))),
        'duration_minutes', v_duration
      )
  where attempt_id = p_attempt_id;
end;
$$;

-- ====================================================================
-- Source: spoken_evaluation_attempt_id_ambiguity_patch.sql
-- ====================================================================

create or replace function public.compute_final_interview_score(p_attempt_id uuid)
returns table (
  attempt_id uuid,
  normalized_score numeric,
  overall_score integer,
  risk_level text,
  result_status text
)
language plpgsql
as $$
declare
  v_attempt public.interview_attempts%rowtype;
  v_total_questions integer;
  v_evaluated_questions integer;
  v_skill_avg numeric := 0;
  v_clarity_avg numeric := 0;
  v_depth_avg numeric := 0;
  v_confidence_avg numeric := 0;
  v_fraud_avg numeric := 0;
  v_cognitive_avg numeric := 0;
  v_required_skills integer := 0;
  v_covered_skills integer := 0;
  v_coverage_ratio numeric := 1;
  v_raw numeric := 0;
  v_normalized numeric := 0;
  v_strengths text := '';
  v_weaknesses text := '';
  v_recommendation text := 'IN_REVIEW';
  v_best_attempt_id uuid;
  v_best_score numeric;
  v_risk_level text := 'MEDIUM';
  v_result_status text := 'IN_REVIEW';
  v_overall_score integer := 0;
begin
  select *
  into v_attempt
  from public.interview_attempts
  where public.interview_attempts.attempt_id = p_attempt_id;

  if not found then
    raise exception 'Attempt not found';
  end if;

  perform public.refresh_attempt_skill_scores(p_attempt_id);

  select
    count(*)::integer,
    count(*) filter (where iae.skill_score is not null)::integer,
    coalesce(avg(iae.skill_score), 0),
    coalesce(avg(iae.clarity_score), 0),
    coalesce(avg(iae.depth_score), 0),
    coalesce(avg(iae.confidence_score), 0),
    coalesce(avg(iae.fraud_score), 0)
  into
    v_total_questions,
    v_evaluated_questions,
    v_skill_avg,
    v_clarity_avg,
    v_depth_avg,
    v_confidence_avg,
    v_fraud_avg
  from public.interview_answers ia
  left join public.interview_answer_evaluations iae
    on iae.answer_id = ia.answer_id
   and iae.evaluator_type = 'AI'
  where ia.attempt_id = p_attempt_id;

  v_cognitive_avg := (v_clarity_avg + v_depth_avg + v_confidence_avg) / 3.0;

  select count(distinct skill_id)
  into v_required_skills
  from (
    select ism.skill_id
    from public.interview_skill_map ism
    where ism.interview_id = v_attempt.interview_id

    union

    select coalesce(iq.target_skill_id, qsm.skill_id) as skill_id
    from public.interview_questions iq
    left join public.question_skill_map qsm
      on qsm.question_id = iq.question_id
    where iq.interview_id = v_attempt.interview_id
  ) skills
  where skill_id is not null;

  select count(distinct skill_id)
  into v_covered_skills
  from public.attempt_skill_scores
  where public.attempt_skill_scores.attempt_id = p_attempt_id
    and public.attempt_skill_scores.normalized_score is not null;

  if v_required_skills > 0 then
    v_coverage_ratio := least(v_covered_skills::numeric / v_required_skills::numeric, 1);
  end if;

  v_raw := greatest(
    least(
      (v_skill_avg * 0.50)
      + (v_cognitive_avg * 0.25)
      + (v_coverage_ratio * 0.25)
      - (v_fraud_avg * 0.20),
      1
    ),
    0
  );

  v_normalized := round(v_raw * 100, 2);
  v_overall_score := round(v_normalized)::integer;

  if v_skill_avg >= 0.70 then
    v_strengths := concat_ws(', ', v_strengths, 'skill coverage');
  end if;

  if v_depth_avg >= 0.70 then
    v_strengths := concat_ws(', ', v_strengths, 'depth of explanation');
  end if;

  if v_confidence_avg >= 0.70 then
    v_strengths := concat_ws(', ', v_strengths, 'confidence');
  end if;

  if v_clarity_avg < 0.55 then
    v_weaknesses := concat_ws(', ', v_weaknesses, 'clarity');
  end if;

  if v_depth_avg < 0.55 then
    v_weaknesses := concat_ws(', ', v_weaknesses, 'depth');
  end if;

  if v_fraud_avg >= 0.60 then
    v_weaknesses := concat_ws(', ', v_weaknesses, 'credibility risk');
  end if;

  if v_normalized >= 75 and v_fraud_avg < 0.35 then
    v_risk_level := 'LOW';
    v_result_status := 'PASSED';
    v_recommendation := 'STRONG_HIRE';
  elsif v_normalized < 45 or v_fraud_avg >= 0.70 then
    v_risk_level := 'HIGH';
    v_result_status := 'FAILED';
    v_recommendation := 'NO_HIRE';
  else
    v_risk_level := 'MEDIUM';
    v_result_status := 'IN_REVIEW';
    v_recommendation := 'REVIEW_REQUIRED';
  end if;

  update public.interview_attempt_scores
  set total_questions = coalesce(v_total_questions, 0),
      evaluated_questions = coalesce(v_evaluated_questions, 0),
      raw_score = v_raw,
      normalized_score = v_normalized,
      evaluated_by = 'AI',
      evaluated_at = now(),
      interview_id = v_attempt.interview_id
  where public.interview_attempt_scores.attempt_id = p_attempt_id;

  if not found then
    insert into public.interview_attempt_scores (
      attempt_id,
      total_questions,
      evaluated_questions,
      raw_score,
      normalized_score,
      evaluated_by,
      evaluated_at,
      interview_id
    )
    values (
      p_attempt_id,
      coalesce(v_total_questions, 0),
      coalesce(v_evaluated_questions, 0),
      v_raw,
      v_normalized,
      'AI',
      now(),
      v_attempt.interview_id
    );
  end if;

  update public.interview_summaries
  set overall_score = v_overall_score,
      risk_level = v_risk_level,
      strengths = nullif(v_strengths, ''),
      weaknesses = nullif(v_weaknesses, ''),
      hire_recommendation = v_recommendation,
      created_at = now()
  where public.interview_summaries.attempt_id = p_attempt_id;

  if not found then
    insert into public.interview_summaries (
      attempt_id,
      overall_score,
      risk_level,
      strengths,
      weaknesses,
      hire_recommendation,
      created_at
    )
    values (
      p_attempt_id,
      v_overall_score,
      v_risk_level,
      nullif(v_strengths, ''),
      nullif(v_weaknesses, ''),
      v_recommendation,
      now()
    );
  end if;

  select ias.attempt_id, ias.normalized_score
  into v_best_attempt_id, v_best_score
  from public.interview_attempt_scores ias
  join public.interview_attempts ia
    on ia.attempt_id = ias.attempt_id
  where ia.interview_id = v_attempt.interview_id
  order by ias.normalized_score desc nulls last, ias.evaluated_at desc
  limit 1;

  update public.interview_results
  set best_attempt_id = v_best_attempt_id,
      final_score = v_best_score,
      result_status = v_result_status,
      decided_at = now()
  where public.interview_results.interview_id = v_attempt.interview_id;

  if not found then
    insert into public.interview_results (
      interview_id,
      best_attempt_id,
      final_score,
      result_status,
      decided_at
    )
    values (
      v_attempt.interview_id,
      v_best_attempt_id,
      v_best_score,
      v_result_status,
      now()
    );
  end if;

  attempt_id := p_attempt_id;
  normalized_score := v_normalized;
  overall_score := v_overall_score;
  risk_level := v_risk_level;
  result_status := v_result_status;

  return next;
end;
$$;


create or replace function public.record_answer_evaluation(
  p_answer_id uuid,
  p_skill_score numeric,
  p_clarity_score numeric,
  p_depth_score numeric,
  p_confidence_score numeric,
  p_fraud_score numeric,
  p_reasoning text,
  p_skill_id uuid default null,
  p_evaluation_json jsonb default '{}'::jsonb
)
returns table (
  attempt_id uuid,
  normalized_score numeric,
  overall_score integer,
  risk_level text,
  result_status text
)
language plpgsql
as $$
declare
  v_answer public.interview_answers%rowtype;
  v_attempt public.interview_attempts%rowtype;
  v_skill_id uuid;
  v_recent_avg numeric;
  v_new_difficulty integer;
  v_out_attempt_id uuid;
  v_out_normalized_score numeric;
  v_out_overall_score integer;
  v_out_risk_level text;
  v_out_result_status text;
begin
  if p_answer_id is null then
    raise exception 'answer_id is required';
  end if;

  select *
  into v_answer
  from public.interview_answers
  where public.interview_answers.answer_id = p_answer_id;

  if not found then
    raise exception 'Answer not found';
  end if;

  select *
  into v_attempt
  from public.interview_attempts
  where public.interview_attempts.attempt_id = v_answer.attempt_id;

  v_skill_id := p_skill_id;

  if v_skill_id is null then
    select coalesce(
      sq.mapped_skill_id,
      iq.target_skill_id,
      qsm.skill_id
    )
    into v_skill_id
    from public.interview_answers ia
    left join public.session_questions sq
      on sq.session_question_id = ia.session_question_id
    left join public.interview_questions iq
      on iq.interview_id = v_attempt.interview_id
     and iq.question_id = ia.question_id
    left join public.question_skill_map qsm
      on qsm.question_id = ia.question_id
    where ia.answer_id = p_answer_id
    limit 1;
  end if;

  update public.interview_answer_evaluations
  set score = p_skill_score * 10,
      feedback = p_reasoning,
      evaluated_at = now(),
      skill_id = v_skill_id,
      skill_score = p_skill_score,
      clarity_score = p_clarity_score,
      depth_score = p_depth_score,
      confidence_score = p_confidence_score,
      fraud_score = p_fraud_score,
      evaluation_json = coalesce(p_evaluation_json, '{}'::jsonb)
  where public.interview_answer_evaluations.answer_id = p_answer_id
    and public.interview_answer_evaluations.evaluator_type = 'AI';

  if not found then
    insert into public.interview_answer_evaluations (
      answer_id,
      evaluator_type,
      score,
      feedback,
      evaluated_at,
      skill_id,
      skill_score,
      clarity_score,
      depth_score,
      confidence_score,
      fraud_score,
      evaluation_json
    )
    values (
      p_answer_id,
      'AI',
      p_skill_score * 10,
      p_reasoning,
      now(),
      v_skill_id,
      p_skill_score,
      p_clarity_score,
      p_depth_score,
      p_confidence_score,
      p_fraud_score,
      coalesce(p_evaluation_json, '{}'::jsonb)
    );
  end if;

  if v_skill_id is not null then
    delete from public.answer_evaluations
    where public.answer_evaluations.answer_id = p_answer_id
      and public.answer_evaluations.skill_id = v_skill_id;

    insert into public.answer_evaluations (
      answer_id,
      skill_id,
      raw_score,
      rubric_reason,
      evaluated_by,
      evaluated_at
    )
    values (
      p_answer_id,
      v_skill_id,
      p_skill_score * 10,
      p_reasoning,
      'AI',
      now()
    );
  end if;

  update public.interview_answers
  set answer_payload = coalesce(answer_payload, '{}'::jsonb) || jsonb_build_object(
    'evaluation',
    jsonb_build_object(
      'skill_score', p_skill_score,
      'clarity_score', p_clarity_score,
      'depth_score', p_depth_score,
      'confidence_score', p_confidence_score,
      'fraud_score', p_fraud_score,
      'reasoning', p_reasoning
    )
  )
  where public.interview_answers.answer_id = p_answer_id;

  select avg(iae.skill_score)
  into v_recent_avg
  from (
    select iae.skill_score
    from public.interview_answer_evaluations iae
    join public.interview_answers ia
      on ia.answer_id = iae.answer_id
    where ia.attempt_id = v_answer.attempt_id
      and iae.evaluator_type = 'AI'
    order by iae.evaluated_at desc
    limit 3
  ) recent;

  v_new_difficulty := coalesce(v_attempt.difficulty_level, 3);

  if coalesce(v_recent_avg, 0) >= 0.75 then
    v_new_difficulty := least(v_new_difficulty + 1, 5);
  elsif coalesce(v_recent_avg, 0) <= 0.45 then
    v_new_difficulty := greatest(v_new_difficulty - 1, 1);
  end if;

  perform public.refresh_attempt_skill_scores(v_answer.attempt_id);

  select
    c.attempt_id,
    c.normalized_score,
    c.overall_score,
    c.risk_level,
    c.result_status
  into
    v_out_attempt_id,
    v_out_normalized_score,
    v_out_overall_score,
    v_out_risk_level,
    v_out_result_status
  from public.compute_final_interview_score(v_answer.attempt_id) c;

  perform public.sync_attempt_adaptive_state(
    v_answer.attempt_id,
    coalesce(v_attempt.current_phase, 'core'),
    v_new_difficulty,
    p_skill_score
  );

  attempt_id := v_out_attempt_id;
  normalized_score := v_out_normalized_score;
  overall_score := v_out_overall_score;
  risk_level := v_out_risk_level;
  result_status := v_out_result_status;

  return next;
end;
$$;

-- ====================================================================
-- Source: record_answer_evaluation_iae_alias_fix.sql
-- ====================================================================

create or replace function public.record_answer_evaluation(
  p_answer_id uuid,
  p_skill_score numeric,
  p_clarity_score numeric,
  p_depth_score numeric,
  p_confidence_score numeric,
  p_fraud_score numeric,
  p_reasoning text,
  p_skill_id uuid default null,
  p_evaluation_json jsonb default '{}'::jsonb
)
returns table (
  attempt_id uuid,
  normalized_score numeric,
  overall_score integer,
  risk_level text,
  result_status text
)
language plpgsql
as $$
declare
  v_answer public.interview_answers%rowtype;
  v_attempt public.interview_attempts%rowtype;
  v_skill_id uuid;
  v_recent_avg numeric;
  v_new_difficulty integer;
  v_out_attempt_id uuid;
  v_out_normalized_score numeric;
  v_out_overall_score integer;
  v_out_risk_level text;
  v_out_result_status text;
begin
  if p_answer_id is null then
    raise exception 'answer_id is required';
  end if;

  select *
  into v_answer
  from public.interview_answers
  where public.interview_answers.answer_id = p_answer_id;

  if not found then
    raise exception 'Answer not found';
  end if;

  select *
  into v_attempt
  from public.interview_attempts
  where public.interview_attempts.attempt_id = v_answer.attempt_id;

  v_skill_id := p_skill_id;

  if v_skill_id is null then
    select coalesce(
      sq.mapped_skill_id,
      iq.target_skill_id,
      qsm.skill_id
    )
    into v_skill_id
    from public.interview_answers ia
    left join public.session_questions sq
      on sq.session_question_id = ia.session_question_id
    left join public.interview_questions iq
      on iq.interview_id = v_attempt.interview_id
     and iq.question_id = ia.question_id
    left join public.question_skill_map qsm
      on qsm.question_id = ia.question_id
    where ia.answer_id = p_answer_id
    limit 1;
  end if;

  update public.interview_answer_evaluations
  set score = p_skill_score * 10,
      feedback = p_reasoning,
      evaluated_at = now(),
      skill_id = v_skill_id,
      skill_score = p_skill_score,
      clarity_score = p_clarity_score,
      depth_score = p_depth_score,
      confidence_score = p_confidence_score,
      fraud_score = p_fraud_score,
      evaluation_json = coalesce(p_evaluation_json, '{}'::jsonb)
  where public.interview_answer_evaluations.answer_id = p_answer_id
    and public.interview_answer_evaluations.evaluator_type = 'AI';

  if not found then
    insert into public.interview_answer_evaluations (
      answer_id,
      evaluator_type,
      score,
      feedback,
      evaluated_at,
      skill_id,
      skill_score,
      clarity_score,
      depth_score,
      confidence_score,
      fraud_score,
      evaluation_json
    )
    values (
      p_answer_id,
      'AI',
      p_skill_score * 10,
      p_reasoning,
      now(),
      v_skill_id,
      p_skill_score,
      p_clarity_score,
      p_depth_score,
      p_confidence_score,
      p_fraud_score,
      coalesce(p_evaluation_json, '{}'::jsonb)
    );
  end if;

  if v_skill_id is not null then
    delete from public.answer_evaluations
    where public.answer_evaluations.answer_id = p_answer_id
      and public.answer_evaluations.skill_id = v_skill_id;

    insert into public.answer_evaluations (
      answer_id,
      skill_id,
      raw_score,
      rubric_reason,
      evaluated_by,
      evaluated_at
    )
    values (
      p_answer_id,
      v_skill_id,
      p_skill_score * 10,
      p_reasoning,
      'AI',
      now()
    );
  end if;

  update public.interview_answers
  set answer_payload = coalesce(answer_payload, '{}'::jsonb) || jsonb_build_object(
    'evaluation',
    jsonb_build_object(
      'skill_score', p_skill_score,
      'clarity_score', p_clarity_score,
      'depth_score', p_depth_score,
      'confidence_score', p_confidence_score,
      'fraud_score', p_fraud_score,
      'reasoning', p_reasoning
    )
  )
  where public.interview_answers.answer_id = p_answer_id;

  select avg(recent.skill_score)
  into v_recent_avg
  from (
    select iae.skill_score
    from public.interview_answer_evaluations iae
    join public.interview_answers ia
      on ia.answer_id = iae.answer_id
    where ia.attempt_id = v_answer.attempt_id
      and iae.evaluator_type = 'AI'
    order by iae.evaluated_at desc
    limit 3
  ) recent;

  v_new_difficulty := coalesce(v_attempt.difficulty_level, 3);

  if coalesce(v_recent_avg, 0) >= 0.75 then
    v_new_difficulty := least(v_new_difficulty + 1, 5);
  elsif coalesce(v_recent_avg, 0) <= 0.45 then
    v_new_difficulty := greatest(v_new_difficulty - 1, 1);
  end if;

  perform public.refresh_attempt_skill_scores(v_answer.attempt_id);

  select
    c.attempt_id,
    c.normalized_score,
    c.overall_score,
    c.risk_level,
    c.result_status
  into
    v_out_attempt_id,
    v_out_normalized_score,
    v_out_overall_score,
    v_out_risk_level,
    v_out_result_status
  from public.compute_final_interview_score(v_answer.attempt_id) c;

  perform public.sync_attempt_adaptive_state(
    v_answer.attempt_id,
    coalesce(v_attempt.current_phase, 'core'),
    v_new_difficulty,
    p_skill_score
  );

  attempt_id := v_out_attempt_id;
  normalized_score := v_out_normalized_score;
  overall_score := v_out_overall_score;
  risk_level := v_out_risk_level;
  result_status := v_out_result_status;

  return next;
end;
$$;

-- ====================================================================
-- Source: adaptive_get_next_interview_question_patch.sql
-- ====================================================================

create or replace function public.get_effective_duration_minutes(p_interview_id uuid)
returns integer
language plpgsql
as $$
declare
  v_duration integer;
begin
  select coalesce(i.duration_minutes, 30)
  into v_duration
  from public.interviews i
  where i.interview_id = p_interview_id;

  return greatest(coalesce(v_duration, 30), 1);
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

  v_effective_count := greatest(v_configured_count, v_planned_count, 1);

  if v_duration >= 25 and v_effective_count < 5 then
    v_effective_count := greatest(v_effective_count, v_duration_target, v_planned_count);
  end if;

  if v_effective_count = 1 and v_planned_count = 0 then
    v_effective_count := greatest(v_effective_count, v_duration_target);
  end if;

  return v_effective_count;
end;
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
  v_clean_answer text;
  v_role text;
  v_experience text;
  v_primary_skill text := nullif(trim(coalesce(p_skill_name, '')), '');
  v_primary_tool text := null;
begin
  if v_answer is null then
    return 'Can you give one concrete example from your recent work and explain the result?';
  end if;

  v_clean_answer := regexp_replace(v_answer, '\s+', ' ', 'g');
  v_clean_answer := regexp_replace(v_clean_answer, '^(hi|hello|hey)\m[\s,.-]*', '', 'i');
  v_clean_answer := regexp_replace(v_clean_answer, '^(so|well|okay|alright|basically|actually)\m[\s,.-]*', '', 'i');
  v_clean_answer := regexp_replace(
    v_clean_answer,
    '\m(my name is|i am|i''m|this is)\M\s+[a-z][a-z\s.''-]{1,40}(?:\s*,\s*|\s+and\s+)',
    '',
    'i'
  );
  v_clean_answer := regexp_replace(
    v_clean_answer,
    '\m(you know|kind of|sort of|basically|actually|like)\M[\s,]*',
    ' ',
    'gi'
  );
  v_clean_answer := trim(regexp_replace(v_clean_answer, '\s+', ' ', 'g'));

  v_role := substring(
    v_clean_answer
    from '(?:i work(?:ing)? as|currently work(?:ing)? as|working as|my role is|i serve as|i''m|i am)\s+(?:an?\s+)?([^,.;]+?)(?:\s+(?:with|where|focused|handling|responsible|using|on)\M|[,.;]|$)'
  );

  if v_role is null then
    v_role := substring(
      v_clean_answer
      from '(?:current role(?: is)?|position(?: is)?)\s+(?:an?\s+)?([^,.;]+?)(?:\s+(?:with|where|focused|handling|responsible|using|on)\M|[,.;]|$)'
    );
  end if;

  if v_role is not null then
    v_role := trim(regexp_replace(v_role, '^(an?|the)\s+', '', 'i'));
    v_role := trim(regexp_replace(v_role, '\m(?:at|with|for)\M.*$', '', 'i'));
    v_role := trim(regexp_replace(v_role, '[.,"'']', '', 'g'));

    if v_role !~* '\m(admin|administrator|engineer|developer|analyst|manager|lead|architect|consultant|specialist|officer)\M' then
      v_role := null;
    end if;
  end if;

  v_experience := substring(
    v_clean_answer
    from '\m(\d+\+?\s+(?:years?|yrs?)(?:\s+of)?\s+(?:experience|in [a-z][a-z\s/-]+)?)\M'
  );

  if v_primary_skill is null then
    if v_clean_answer ~* '\mdatabase administration\M' then
      v_primary_skill := 'database administration';
    elsif v_clean_answer ~* '\mdatabase management\M' then
      v_primary_skill := 'database management';
    elsif v_clean_answer ~* '\mperformance tuning\M' then
      v_primary_skill := 'performance tuning';
    elsif v_clean_answer ~* '\mquery optimization\M' then
      v_primary_skill := 'query optimization';
    elsif v_clean_answer ~* '\mbackup and recovery\M' then
      v_primary_skill := 'backup and recovery';
    elsif v_clean_answer ~* '\mincident management\M' then
      v_primary_skill := 'incident management';
    elsif v_clean_answer ~* '\msystem design\M' then
      v_primary_skill := 'system design';
    elsif v_clean_answer ~* '\mapi development\M' then
      v_primary_skill := 'api development';
    elsif v_clean_answer ~* '\mdata migration\M' then
      v_primary_skill := 'data migration';
    elsif v_clean_answer ~* '\metl\M' then
      v_primary_skill := 'ETL';
    elsif v_clean_answer ~* '\msql\M' then
      v_primary_skill := 'SQL';
    elsif v_clean_answer ~* '\mtypescript\M' then
      v_primary_skill := 'TypeScript';
    elsif v_clean_answer ~* '\mnode\.?js\M' then
      v_primary_skill := 'Node.js';
    elsif v_clean_answer ~* '\mreact\M' then
      v_primary_skill := 'React';
    elsif v_clean_answer ~* '\mpython\M' then
      v_primary_skill := 'Python';
    end if;
  end if;

  if v_clean_answer ~* '\moracle\M' then
    v_primary_tool := 'Oracle';
  elsif v_clean_answer ~* '\mpostgresql\M|\mpostgres\M' then
    v_primary_tool := 'PostgreSQL';
  elsif v_clean_answer ~* '\mmysql\M' then
    v_primary_tool := 'MySQL';
  elsif v_clean_answer ~* '\mmongodb\M' then
    v_primary_tool := 'MongoDB';
  elsif v_clean_answer ~* '\msql server\M' then
    v_primary_tool := 'SQL Server';
  elsif v_clean_answer ~* '\mlinux\M' then
    v_primary_tool := 'Linux';
  elsif v_clean_answer ~* '\maws\M' then
    v_primary_tool := 'AWS';
  elsif v_clean_answer ~* '\mazure\M' then
    v_primary_tool := 'Azure';
  elsif v_clean_answer ~* '\mdocker\M' then
    v_primary_tool := 'Docker';
  elsif v_clean_answer ~* '\mkubernetes\M' then
    v_primary_tool := 'Kubernetes';
  elsif v_clean_answer ~* '\mjira\M' then
    v_primary_tool := 'Jira';
  end if;

  if coalesce(p_is_contradiction, false) then
    return 'Can you clarify the specific steps you took, the decisions you made, and how you verified the outcome?';
  end if;

  if coalesce(p_probe_type, '') = 'numbers' then
    return 'What was the measurable outcome of that work, and how did you track it?';
  end if;

  if coalesce(p_probe_type, '') = 'tools' and coalesce(v_primary_tool, v_primary_skill) is not null then
    return format(
      'How have you used %s in a recent project, and what was the result?',
      coalesce(v_primary_tool, v_primary_skill)
    );
  end if;

  if v_role is not null and coalesce(v_primary_skill, v_primary_tool) is not null then
    return format(
      'In your role as a %s, can you walk me through a recent project where you applied %s?',
      v_role,
      coalesce(v_primary_skill, v_primary_tool)
    );
  end if;

  if v_role is not null then
    return format(
      'In your role as a %s, can you walk me through a recent project and the outcome?',
      v_role
    );
  end if;

  if coalesce(v_primary_skill, v_primary_tool) is not null then
    return format(
      'Can you walk me through a recent project where you used %s and the result you achieved?',
      coalesce(v_primary_skill, v_primary_tool)
    );
  end if;

  if v_experience is not null then
    return format(
      'From your %s, can you share one concrete example of a problem you solved and the result?',
      v_experience
    );
  end if;

  return 'Can you walk me through one recent project, your responsibilities, and the outcome?';
end;
$$;

create or replace function public.build_follow_up_question(p_last_answer text)
returns text
language sql
as $$
  select public.build_follow_up_question($1, null, null, null, false);
$$;

create or replace function public.get_next_interview_question(
  p_attempt_id uuid,
  p_last_answer text default null
)
returns table (
  session_question_id uuid,
  question_id uuid,
  content text,
  source text,
  question_kind text,
  question_order integer,
  asked_at timestamptz,
  is_complete boolean
)
language plpgsql
as $$
declare
  v_attempt public.interview_attempts%rowtype;
  v_target_questions integer;
  v_duration integer;
  v_phase text;
  v_difficulty integer;
  v_asked_total integer;
  v_asked_follow_ups integer;
  v_remaining_slots integer;
  v_remaining_required_followups integer;
  v_latest_question public.session_questions%rowtype;
  v_base_question_id uuid;
  v_followups_for_base integer := 0;
  v_latest_answer_text text;
  v_last_skill numeric := null;
  v_last_clarity numeric := null;
  v_last_depth numeric := null;
  v_last_confidence numeric := null;
  v_last_fraud numeric := null;
  v_should_follow_up boolean := false;
  v_probe_type text := null;
  v_skill_id uuid := null;
  v_skill_name text := null;
  v_next_order integer;
  v_next_core record;
  v_score_attempt_id uuid;
  v_score_normalized numeric;
  v_score_overall integer;
  v_score_risk text;
  v_score_result text;
  v_is_overview_question boolean := false;
  v_answer_word_count integer := 0;
  v_mentions_role boolean := false;
  v_mentions_technology boolean := false;
begin
  if p_attempt_id is null then
    raise exception 'attempt_id is required';
  end if;

  select *
  into v_attempt
  from public.interview_attempts
  where attempt_id = p_attempt_id;

  if not found then
    raise exception 'Interview attempt not found';
  end if;

  v_duration := public.get_effective_duration_minutes(v_attempt.interview_id);
  v_target_questions := public.get_effective_question_count(v_attempt.interview_id);
  v_phase := public.get_current_phase(v_attempt.started_at, v_duration);
  v_difficulty := coalesce(v_attempt.difficulty_level, 3);

  select count(*)
  into v_asked_total
  from public.session_questions
  where attempt_id = p_attempt_id;

  select count(*)
  into v_asked_follow_ups
  from public.session_questions
  where attempt_id = p_attempt_id
    and question_kind = 'follow_up';

  v_remaining_slots := greatest(v_target_questions - v_asked_total, 0);
  v_remaining_required_followups := greatest(
    coalesce((select required_follow_up_questions from public.interviews where interview_id = v_attempt.interview_id), 2) - v_asked_follow_ups,
    0
  );

  if extract(epoch from (now() - v_attempt.started_at)) >= (v_duration * 60) or v_remaining_slots <= 0 then
    update public.interview_attempts
    set status = 'completed',
        ended_at = now(),
        current_phase = 'closing'
    where attempt_id = p_attempt_id;

    select
      c.attempt_id,
      c.normalized_score,
      c.overall_score,
      c.risk_level,
      c.result_status
    into
      v_score_attempt_id,
      v_score_normalized,
      v_score_overall,
      v_score_risk,
      v_score_result
    from public.compute_final_interview_score(p_attempt_id) c;

    is_complete := true;
    return next;
    return;
  end if;

  select *
  into v_latest_question
  from public.session_questions
  where attempt_id = p_attempt_id
  order by question_order desc, asked_at desc nulls last
  limit 1;

  if v_latest_question.session_question_id is not null then
    select coalesce(nullif(trim(coalesce(p_last_answer, '')), ''), ia.answer_text)
    into v_latest_answer_text
    from public.interview_answers ia
    where ia.session_question_id = v_latest_question.session_question_id
    order by ia.answered_at desc nulls last
    limit 1;

    select
      iae.skill_score,
      iae.clarity_score,
      iae.depth_score,
      iae.confidence_score,
      iae.fraud_score,
      coalesce(iae.skill_id, sq.mapped_skill_id)
    into
      v_last_skill,
      v_last_clarity,
      v_last_depth,
      v_last_confidence,
      v_last_fraud,
      v_skill_id
    from public.interview_answers ia
    left join public.interview_answer_evaluations iae
      on iae.answer_id = ia.answer_id
     and iae.evaluator_type = 'AI'
    left join public.session_questions sq
      on sq.session_question_id = ia.session_question_id
    where ia.session_question_id = v_latest_question.session_question_id
    order by ia.answered_at desc nulls last
    limit 1;

    v_base_question_id := case
      when v_latest_question.question_kind = 'follow_up' then v_latest_question.parent_session_question_id
      else v_latest_question.session_question_id
    end;

    if v_base_question_id is not null then
      select count(*)
      into v_followups_for_base
      from public.session_questions
      where attempt_id = p_attempt_id
        and parent_session_question_id = v_base_question_id;
    end if;
  end if;

  if v_skill_id is not null then
    select sm.skill_name
    into v_skill_name
    from public.skill_master sm
    where sm.skill_id = v_skill_id;
  end if;

  if v_last_skill is not null then
    if v_last_skill >= 0.75 then
      v_difficulty := least(v_difficulty + 1, 5);
    elsif v_last_skill <= 0.45 then
      v_difficulty := greatest(v_difficulty - 1, 1);
    end if;
  end if;

  v_is_overview_question := coalesce(v_latest_question.content, '') ~* '(tell me about your experience|tell me about yourself|walk me through your background|work most relevant to this role|roles? and responsibilities|current role)';
  v_answer_word_count := coalesce(array_length(regexp_split_to_array(trim(coalesce(v_latest_answer_text, '')), '\s+'), 1), 0);
  v_mentions_role := coalesce(v_latest_answer_text, '') ~* '\m(currently|working as|my role|responsib|experience|years?|senior|lead|engineer|administrator|developer|analyst|manager)\M';
  v_mentions_technology := coalesce(v_latest_answer_text, '') ~* '\m(sql|oracle|postgres|postgresql|mysql|database|dba|linux|aws|azure|etl|jira|mongodb|python|java|node|typescript|react)\M';

  if v_latest_question.session_question_id is not null
     and coalesce(nullif(trim(coalesce(v_latest_answer_text, '')), ''), '') <> ''
     and v_followups_for_base < 2
     and not (v_is_overview_question and v_answer_word_count >= 35 and v_mentions_role and v_mentions_technology)
     and (
       v_remaining_required_followups > 0
       or coalesce(v_last_skill, 0.50) < 0.55
       or coalesce(v_last_depth, 0.50) < 0.55
       or coalesce(v_last_clarity, 0.50) < 0.55
       or coalesce(v_last_fraud, 0) >= 0.65
     )
  then
    v_should_follow_up := true;

    if coalesce(v_last_fraud, 0) >= 0.65 then
      v_probe_type := 'contradiction';
    elsif coalesce(v_last_skill, 1) < 0.45 or coalesce(v_last_clarity, 1) < 0.55 then
      v_probe_type := 'clarify';
    elsif coalesce(v_last_depth, 1) < 0.55 then
      v_probe_type := 'deeper';
    elsif coalesce(v_last_confidence, 1) < 0.55 then
      v_probe_type := 'tools';
    else
      v_probe_type := 'numbers';
    end if;
  end if;

  select coalesce(max(question_order), 0) + 1
  into v_next_order
  from public.session_questions
  where attempt_id = p_attempt_id;

  if v_should_follow_up then
    insert into public.session_questions (
      attempt_id,
      question_id,
      parent_session_question_id,
      content,
      source,
      question_kind,
      question_order,
      source_context,
      mapped_skill_id,
      phase,
      difficulty_level,
      probe_type,
      contradiction_probe
    )
    values (
      p_attempt_id,
      null,
      v_base_question_id,
      public.build_follow_up_question(
        v_latest_answer_text,
        v_latest_question.content,
        v_skill_name,
        v_probe_type,
        v_probe_type = 'contradiction'
      ),
      'ai',
      'follow_up',
      v_next_order,
      jsonb_build_object(
        'parent_session_question_id', v_base_question_id,
        'probe_type', v_probe_type,
        'generated_from_answer', left(coalesce(v_latest_answer_text, ''), 250)
      ),
      v_skill_id,
      v_phase,
      v_difficulty,
      v_probe_type,
      v_probe_type = 'contradiction'
    )
    returning
      session_questions.session_question_id,
      session_questions.question_id,
      session_questions.content,
      session_questions.source,
      session_questions.question_kind,
      session_questions.question_order,
      session_questions.asked_at
    into session_question_id, question_id, content, source, question_kind, question_order, asked_at;

    perform public.sync_attempt_adaptive_state(
      p_attempt_id,
      v_phase,
      v_difficulty,
      v_last_skill
    );

    is_complete := false;
    return next;
    return;
  end if;

  with covered_skills as (
    select distinct coalesce(
      sq.mapped_skill_id,
      iq.target_skill_id,
      qsm.skill_id
    ) as skill_id
    from public.session_questions sq
    join public.interview_attempts ia
      on ia.attempt_id = sq.attempt_id
    left join public.interview_questions iq
      on iq.interview_id = ia.interview_id
     and iq.question_id = sq.question_id
    left join public.question_skill_map qsm
      on qsm.question_id = sq.question_id
    where sq.attempt_id = p_attempt_id
      and sq.question_kind = 'core'
  )
  select
    iq.question_id,
    coalesce(iq.question_text, q.question_text) as content,
    coalesce(iq.target_skill_id, qsm.skill_id) as mapped_skill_id,
    iq.source_type,
    iq.reference_context,
    iq.difficulty_level
  into v_next_core
  from public.interview_questions iq
  left join public.questions q
    on q.question_id = iq.question_id
   and q.is_active = true
  left join public.question_skill_map qsm
    on qsm.question_id = iq.question_id
  where iq.interview_id = v_attempt.interview_id
    and not exists (
      select 1
      from public.session_questions sq
      where sq.attempt_id = p_attempt_id
        and sq.question_kind = 'core'
        and sq.question_id = iq.question_id
    )
  order by
    case
      when coalesce(iq.target_skill_id, qsm.skill_id) is not null
       and not exists (
         select 1
         from covered_skills cs
         where cs.skill_id = coalesce(iq.target_skill_id, qsm.skill_id)
       )
      then 0 else 1
    end,
    case when coalesce(iq.phase_hint, 'core') = v_phase then 0 else 1 end,
    abs(coalesce(iq.difficulty_level, coalesce(q.difficulty_level, 3)) - v_difficulty),
    iq.question_order asc
  limit 1;

  if v_next_core.question_id is not null or v_next_core.content is not null then
    insert into public.session_questions (
      attempt_id,
      question_id,
      content,
      source,
      question_kind,
      question_order,
      source_context,
      mapped_skill_id,
      phase,
      difficulty_level
    )
    values (
      p_attempt_id,
      v_next_core.question_id,
      coalesce(v_next_core.content, 'Tell me about your experience and the work most relevant to this role.'),
      'system',
      case when v_phase = 'closing' then 'closing' else 'core' end,
      v_next_order,
      jsonb_build_object(
        'source_type', coalesce(v_next_core.source_type, 'unknown'),
        'reference_context', coalesce(v_next_core.reference_context, '{}'::jsonb)
      ),
      v_next_core.mapped_skill_id,
      v_phase,
      coalesce(v_next_core.difficulty_level, v_difficulty)
    )
    returning
      session_questions.session_question_id,
      session_questions.question_id,
      session_questions.content,
      session_questions.source,
      session_questions.question_kind,
      session_questions.question_order,
      session_questions.asked_at
    into session_question_id, question_id, content, source, question_kind, question_order, asked_at;

    perform public.sync_attempt_adaptive_state(
      p_attempt_id,
      v_phase,
      v_difficulty,
      v_last_skill
    );

    is_complete := false;
    return next;
    return;
  end if;

  update public.interview_attempts
  set status = 'completed',
      ended_at = now(),
      current_phase = 'closing'
  where attempt_id = p_attempt_id;

  select
    c.attempt_id,
    c.normalized_score,
    c.overall_score,
    c.risk_level,
    c.result_status
  into
    v_score_attempt_id,
    v_score_normalized,
    v_score_overall,
    v_score_risk,
    v_score_result
  from public.compute_final_interview_score(p_attempt_id) c;

  is_complete := true;
  return next;
end;
$$;

grant all on function public.get_effective_duration_minutes(uuid) to anon, authenticated, service_role;
grant all on function public.refresh_attempt_skill_scores(uuid) to anon, authenticated, service_role;
grant all on function public.sync_attempt_adaptive_state(uuid, text, integer, numeric) to anon, authenticated, service_role;
grant all on function public.compute_final_interview_score(uuid) to anon, authenticated, service_role;
grant all on function public.record_answer_evaluation(uuid, numeric, numeric, numeric, numeric, numeric, text, uuid, jsonb) to anon, authenticated, service_role;
grant all on function public.get_next_interview_question(uuid, text) to anon, authenticated, service_role;
