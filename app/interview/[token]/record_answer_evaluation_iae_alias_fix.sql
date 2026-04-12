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
