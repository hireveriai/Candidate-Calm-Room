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
