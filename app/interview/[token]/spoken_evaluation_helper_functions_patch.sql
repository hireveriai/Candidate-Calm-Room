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
