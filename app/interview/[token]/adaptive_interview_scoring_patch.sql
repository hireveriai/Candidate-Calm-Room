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
  where attempt_id = p_attempt_id;

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
  where attempt_id = p_attempt_id
    and normalized_score is not null;

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
  where interview_attempt_scores.attempt_id = p_attempt_id;

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
  where interview_summaries.attempt_id = p_attempt_id;

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
  where interview_results.interview_id = v_attempt.interview_id;

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
  where answer_id = p_answer_id;

  if not found then
    raise exception 'Answer not found';
  end if;

  select *
  into v_attempt
  from public.interview_attempts
  where attempt_id = v_answer.attempt_id;

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
  where answer_id = p_answer_id
    and evaluator_type = 'AI';

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
    where answer_id = p_answer_id
      and skill_id = v_skill_id;

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
  where answer_id = p_answer_id;

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
