create or replace function public.normalize_seed_text(p_value text)
returns text
language sql
immutable
as $$
  select nullif(regexp_replace(coalesce(p_value, ''), '\s+', ' ', 'g'), '');
$$;

create or replace function public.normalize_question_memory_key(p_value text)
returns text
language sql
immutable
as $$
  select coalesce(
    nullif(
      regexp_replace(lower(public.normalize_seed_text(p_value)), '[^a-z0-9]+', ' ', 'g'),
      ''
    ),
    ''
  );
$$;

create or replace function public.clean_job_role_title(p_value text)
returns text
language plpgsql
immutable
as $$
declare
  v_cleaned text := public.normalize_seed_text(p_value);
  v_tokens text[];
  v_noise_tokens text[] := array[
    'apac', 'asia', 'bangalore', 'bengaluru', 'blr', 'chennai', 'delhi',
    'dubai', 'emea', 'europe', 'gurgaon', 'gurugram', 'holland', 'hybrid',
    'hyderabad', 'india', 'kolkata', 'london', 'mumbai', 'netherlands',
    'noida', 'onsite', 'on-site', 'pune', 'remote', 'singapore', 'uae',
    'uk', 'usa', 'us', 'wfh'
  ];
begin
  if v_cleaned is null then
    return null;
  end if;

  v_cleaned := regexp_replace(
    v_cleaned,
    '\((?:[^)]*\m(remote|hybrid|onsite|on-site|wfh|work from home|shift|bangalore|bengaluru|holland|netherlands|india|uk|usa|us)\M[^)]*)\)',
    ' ',
    'gi'
  );
  v_cleaned := regexp_replace(v_cleaned, '\m(sr)\.?\M', 'Senior', 'gi');
  v_cleaned := regexp_replace(v_cleaned, '\m(jr)\.?\M', 'Junior', 'gi');
  v_cleaned := regexp_replace(v_cleaned, '\m(assoc)\.?\M', 'Associate', 'gi');

  if position(' | ' in v_cleaned) > 0 then
    v_cleaned := split_part(v_cleaned, ' | ', 1);
  end if;

  if position(' - ' in v_cleaned) > 0 then
    if split_part(lower(v_cleaned), ' - ', 1) ~ '(remote|hybrid|onsite|on-site|wfh|shift|bangalore|bengaluru|holland|india|uk|usa|us)'
    then
      v_cleaned := split_part(v_cleaned, ' - ', 2);
    else
      v_cleaned := split_part(v_cleaned, ' - ', 1);
    end if;
  end if;

  if position(', ' in v_cleaned) > 0 then
    v_cleaned := split_part(v_cleaned, ', ', 1);
  end if;

  v_cleaned := regexp_replace(v_cleaned, '\m(remote|hybrid|onsite|on-site|work from home|wfh)\M', ' ', 'gi');
  v_cleaned := regexp_replace(
    v_cleaned,
    '\m(day|night|rotational|general|morning|evening|first|second|third|1st|2nd|3rd|us|uk|europe|emea|apac|ist)\M\s+\mshift\M',
    ' ',
    'gi'
  );
  v_cleaned := regexp_replace(v_cleaned, '\mshift\M\s*[a-z0-9:+-]*', ' ', 'gi');
  v_cleaned := public.normalize_seed_text(v_cleaned);

  if v_cleaned is null then
    return null;
  end if;

  v_tokens := regexp_split_to_array(v_cleaned, '\s+');

  while coalesce(array_length(v_tokens, 1), 0) > 0
    and lower(v_tokens[1]) = any(v_noise_tokens) loop
    v_tokens := v_tokens[2:array_length(v_tokens, 1)];
  end loop;

  while coalesce(array_length(v_tokens, 1), 0) > 0
    and lower(v_tokens[array_length(v_tokens, 1)]) = any(v_noise_tokens) loop
    v_tokens := v_tokens[1:array_length(v_tokens, 1) - 1];
  end loop;

  v_cleaned := public.normalize_seed_text(array_to_string(v_tokens, ' '));

  if v_cleaned is null then
    return null;
  end if;

  return initcap(lower(v_cleaned));
end;
$$;

create or replace function public.dedupe_text_array(p_values text[])
returns text[]
language sql
immutable
as $$
  with cleaned as (
    select nullif(trim(value), '') as value
    from unnest(coalesce(p_values, '{}'::text[])) as value
  ),
  ranked as (
    select distinct value, length(value) as value_length
    from cleaned
    where value is not null
  )
  select coalesce(
    array(
      select value
      from ranked
      order by value_length desc, value
    ),
    '{}'::text[]
  );
$$;

create or replace function public.extract_claim_anchors(p_claims jsonb)
returns text[]
language sql
stable
as $$
  with array_claims as (
    select nullif(trim(value), '') as claim
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(coalesce(p_claims, '[]'::jsonb)) = 'array' then coalesce(p_claims, '[]'::jsonb)
        else '[]'::jsonb
      end
    ) as value
  ),
  object_claims as (
    select nullif(trim(value), '') as claim
    from jsonb_each_text(
      case
        when jsonb_typeof(coalesce(p_claims, '{}'::jsonb)) = 'object' then coalesce(p_claims, '{}'::jsonb)
        else '{}'::jsonb
      end
    )
  ),
  combined as (
    select claim from array_claims
    union
    select claim from object_claims
  ),
  ranked as (
    select distinct left(claim, 120) as claim, length(claim) as claim_length
    from combined
    where claim is not null
      and length(claim) >= 15
  )
  select coalesce(
    array(
      select claim
      from ranked
      order by claim_length desc, claim
      limit 6
    ),
    '{}'::text[]
  );
$$;

create or replace function public.extract_resume_claims_json(p_resume_text text)
returns jsonb
language sql
stable
as $$
  with claim_lines as (
    select distinct left(trim(line), 220) as claim
    from regexp_split_to_table(coalesce(p_resume_text, ''), E'[\\n\\r]+|[.?!]') as line
    where length(trim(line)) between 25 and 220
      and trim(line) !~* '^(name|email|phone|mobile|address|linkedin|github|summary|profile|education|certification|skills)\b'
  )
  select coalesce(jsonb_agg(claim), '[]'::jsonb)
  from (
    select claim
    from claim_lines
    limit 6
  ) as ranked_claims;
$$;

create or replace function public.extract_job_description_anchors(p_job_description text)
returns text[]
language sql
stable
as $$
  with responsibility_lines as (
    select distinct nullif(trim(line), '') as responsibility
    from regexp_split_to_table(coalesce(p_job_description, ''), E'[\\n\\r]+|[.?!;]') as line
    where length(trim(line)) between 20 and 180
      and trim(line) ~* '\m(handle|manage|maintain|monitor|optimi[sz]e|troubleshoot|support|design|deliver|migrate|automate|secure|improve|own|lead)\M'
  ),
  ranked as (
    select responsibility, length(responsibility) as responsibility_length
    from responsibility_lines
    where responsibility is not null
  )
  select coalesce(
    array(
      select responsibility
      from ranked
      order by responsibility_length desc, responsibility
      limit 6
    ),
    '{}'::text[]
  );
$$;

create or replace function public.derive_resume_experience_years(p_resume_text text)
returns integer
language plpgsql
stable
as $$
declare
  v_match text;
begin
  v_match := substring(lower(coalesce(p_resume_text, '')) from '([0-9]{1,2})\+?\s*(?:years|yrs)');

  if v_match ~ '^[0-9]+$' then
    return greatest(v_match::integer, 0);
  end if;

  return null;
end;
$$;

create or replace function public.get_candidate_resume_text(p_candidate_id uuid)
returns text
language plpgsql
stable
as $$
declare
  v_resume_text text;
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'candidates'
      and column_name = 'resume_text'
  ) then
    execute 'select nullif(trim(resume_text), '''') from public.candidates where candidate_id = $1 limit 1'
      into v_resume_text
      using p_candidate_id;
  end if;

  return public.normalize_seed_text(v_resume_text);
end;
$$;

create or replace function public.extract_resume_skills(
  p_resume_text text,
  p_job_skills text[],
  p_interview_skill_names text[]
)
returns text[]
language sql
stable
as $$
  with anchors as (
    select distinct nullif(trim(skill), '') as skill
    from unnest(
      coalesce(p_job_skills, '{}'::text[]) || coalesce(p_interview_skill_names, '{}'::text[])
    ) as skill
  ),
  matched as (
    select skill
    from anchors
    where skill is not null
      and position(lower(skill) in lower(coalesce(p_resume_text, ''))) > 0
  )
  select coalesce(
    array(
      select skill
      from matched
      order by length(skill) desc, skill
      limit 10
    ),
    '{}'::text[]
  );
$$;

create or replace function public.compute_overlap_skills(
  p_resume_anchors text[],
  p_job_skills text[]
)
returns text[]
language sql
stable
as $$
  with resume_anchors as (
    select distinct nullif(trim(anchor), '') as anchor
    from unnest(coalesce(p_resume_anchors, '{}'::text[])) as anchor
  ),
  job_skills as (
    select distinct nullif(trim(skill), '') as skill
    from unnest(coalesce(p_job_skills, '{}'::text[])) as skill
  ),
  matched as (
    select distinct js.skill, length(js.skill) as skill_length
    from job_skills js
    join resume_anchors ra
      on lower(js.skill) = lower(ra.anchor)
         or (
           length(lower(js.skill)) >= 4
           and length(lower(ra.anchor)) >= 4
           and (
             position(lower(js.skill) in lower(ra.anchor)) > 0
             or position(lower(ra.anchor) in lower(js.skill)) > 0
           )
         )
    where js.skill is not null
      and ra.anchor is not null
  )
  select coalesce(
    array(
      select skill
      from matched
      order by skill_length desc, skill
    ),
    '{}'::text[]
  );
$$;

create or replace function public.derive_effective_question_target(
  p_duration_minutes integer,
  p_configured_count integer
)
returns integer
language plpgsql
immutable
as $$
declare
  v_duration_target integer;
  v_effective_count integer := greatest(coalesce(p_configured_count, 0), 1);
  v_duration integer := greatest(coalesce(p_duration_minutes, 0), 0);
begin
  v_duration_target := case
    when v_duration >= 60 then 17
    when v_duration >= 45 then 13
    when v_duration >= 30 then 9
    when v_duration >= 20 then 7
    when v_duration >= 15 then 5
    when v_duration >= 10 then 4
    when v_duration > 0 then 3
    else 9
  end;

  if v_duration >= 25 and v_effective_count < 5 then
    v_effective_count := greatest(v_effective_count, v_duration_target);
  end if;

  return greatest(v_effective_count, 1);
end;
$$;

create or replace function public.build_question_distribution(
  p_total_questions integer,
  p_has_resume_context boolean
)
returns table (
  resume_count integer,
  job_count integer,
  behavioral_count integer
)
language plpgsql
immutable
as $$
declare
  v_total integer := greatest(coalesce(p_total_questions, 0), 1);
  v_assigned integer;
begin
  if p_has_resume_context then
    resume_count := floor(v_total * 0.30)::integer;
    job_count := floor(v_total * 0.50)::integer;
    behavioral_count := floor(v_total * 0.20)::integer;
  else
    resume_count := 0;
    job_count := floor(v_total * 0.70)::integer;
    behavioral_count := floor(v_total * 0.30)::integer;
  end if;

  v_assigned := resume_count + job_count + behavioral_count;

  while v_assigned < v_total loop
    if job_count <= behavioral_count or behavioral_count = 0 then
      job_count := job_count + 1;
    elsif p_has_resume_context and resume_count <= behavioral_count then
      resume_count := resume_count + 1;
    else
      behavioral_count := behavioral_count + 1;
    end if;

    v_assigned := resume_count + job_count + behavioral_count;
  end loop;

  if p_has_resume_context and resume_count = 0 and v_total >= 3 then
    resume_count := 1;

    if job_count >= behavioral_count and job_count > 0 then
      job_count := job_count - 1;
    elsif behavioral_count > 0 then
      behavioral_count := behavioral_count - 1;
    end if;
  end if;

  return next;
end;
$$;

create or replace function public.derive_seed_phase(
  p_question_order integer,
  p_total_questions integer
)
returns text
language plpgsql
immutable
as $$
declare
  v_order integer := greatest(coalesce(p_question_order, 1), 1);
  v_total integer := greatest(coalesce(p_total_questions, 1), 1);
  v_progress numeric := v_order::numeric / v_total::numeric;
begin
  if v_progress <= 0.20 then
    return 'warmup';
  end if;

  if v_progress <= 0.75 then
    return 'core';
  end if;

  if v_progress < 1 then
    return 'probe';
  end if;

  return 'closing';
end;
$$;

create or replace function public.build_seed_question_text(
  p_source_type text,
  p_role_title text,
  p_anchor text,
  p_variant integer
)
returns text
language plpgsql
immutable
as $$
declare
  v_anchor text := public.normalize_seed_text(p_anchor);
begin
  if p_source_type = 'resume' then
    return case mod(greatest(coalesce(p_variant, 0), 0), 3)
      when 0 then format('You highlighted %s. What was the most demanding piece of work around it, and how did you deliver the result?', coalesce(v_anchor, 'your recent background'))
      when 1 then format('Your background includes %s. What problem forced you to go deepest technically, and what did you change?', coalesce(v_anchor, 'your recent work'))
      else format('When %s mattered most in your work, what outcome were you responsible for and how did you get there?', coalesce(v_anchor, 'your core work'))
    end;
  end if;

  if p_source_type = 'behavioral' then
    return case mod(greatest(coalesce(p_variant, 0), 0), 3)
      when 0 then format('When work around %s started going off track, how did you regain control and align the team?', coalesce(v_anchor, 'a critical responsibility in this role'))
      when 1 then format('Think of a time you had conflicting priorities around %s. How did you decide what to protect first?', coalesce(v_anchor, 'an important responsibility'))
      else format('When people pushed for speed on %s, how did you defend quality, reliability, or risk controls?', coalesce(v_anchor, 'this role'))
    end;
  end if;

  return case mod(greatest(coalesce(p_variant, 0), 0), 4)
    when 0 then format('How do you troubleshoot %s when it starts failing in production?', coalesce(v_anchor, 'the core responsibilities of this role'))
    when 1 then format('If you had to improve %s under real delivery pressure, what would you examine first?', coalesce(v_anchor, 'execution in the core responsibilities'))
    when 2 then format('What signals tell you %s is degrading, and what actions do you take next?', coalesce(v_anchor, 'this responsibility'))
    else format('Walk me through how you would execute %s reliably in a live environment.', coalesce(v_anchor, 'this area'))
  end;
end;
$$;

create or replace function public.resolve_seed_skill_id(
  p_interview_id uuid,
  p_anchor text
)
returns uuid
language sql
stable
as $$
  with normalized_anchor as (
    select lower(public.normalize_seed_text(p_anchor)) as anchor
  ),
  preferred_match as (
    select sm.skill_id
    from public.interview_skill_map ism
    join public.skill_master sm
      on sm.skill_id = ism.skill_id
    join normalized_anchor na
      on lower(coalesce(sm.skill_name, sm.skill_code, '')) = na.anchor
         or lower(coalesce(sm.skill_code, sm.skill_name, '')) = na.anchor
    where ism.interview_id = p_interview_id
    limit 1
  ),
  fallback_match as (
    select sm.skill_id
    from public.skill_master sm
    join normalized_anchor na
      on lower(coalesce(sm.skill_name, sm.skill_code, '')) = na.anchor
         or lower(coalesce(sm.skill_code, sm.skill_name, '')) = na.anchor
    limit 1
  )
  select coalesce(
    (select skill_id from preferred_match),
    (select skill_id from fallback_match)
  );
$$;

create or replace function public.ensure_candidate_resume_profile(p_interview_id uuid)
returns boolean
language plpgsql
as $$
declare
  v_candidate_id uuid;
  v_job_skills text[];
  v_interview_skills text[];
  v_resume_text text;
  v_existing_resume_id uuid;
begin
  select cra.resume_ai_id
    into v_existing_resume_id
  from public.candidate_resume_ai cra
  where cra.interview_id = p_interview_id
  order by cra.created_at desc nulls last, cra.resume_ai_id desc
  limit 1;

  if v_existing_resume_id is not null then
    return true;
  end if;

  select
    i.candidate_id,
    coalesce(jp.core_skills, '{}'::text[])
    into v_candidate_id,
         v_job_skills
  from public.interviews i
  join public.job_positions jp
    on jp.job_id = i.job_id
  where i.interview_id = p_interview_id
  limit 1;

  if v_candidate_id is null then
    return false;
  end if;

  select coalesce(
           array_agg(distinct coalesce(sm.skill_name, sm.skill_code))
             filter (where nullif(trim(coalesce(sm.skill_name, sm.skill_code)), '') is not null),
           '{}'::text[]
         )
    into v_interview_skills
  from public.interview_skill_map ism
  join public.skill_master sm
    on sm.skill_id = ism.skill_id
  where ism.interview_id = p_interview_id;

  v_resume_text := public.get_candidate_resume_text(v_candidate_id);

  if v_resume_text is null then
    return false;
  end if;

  insert into public.candidate_resume_ai (
    interview_id,
    raw_resume,
    extracted_skills,
    claimed_experience_years,
    extracted_claims
  )
  values (
    p_interview_id,
    v_resume_text,
    public.extract_resume_skills(v_resume_text, v_job_skills, v_interview_skills),
    public.derive_resume_experience_years(v_resume_text),
    public.extract_resume_claims_json(v_resume_text)
  );

  return true;
end;
$$;

create or replace function public.ensure_interview_questions_seeded(
  p_interview_id uuid,
  p_force_regenerate boolean default false
)
returns integer
language plpgsql
as $$
declare
  v_existing_count integer := 0;
  v_non_dynamic_count integer := 0;
  v_question_count integer;
  v_duration_minutes integer;
  v_role_title text;
  v_job_skills text[];
  v_job_description text;
  v_job_responsibilities text[];
  v_interview_skills text[];
  v_resume_skills text[];
  v_resume_claims jsonb;
  v_claim_anchors text[];
  v_resume_years integer;
  v_resume_anchors text[];
  v_overlap_anchors text[];
  v_job_anchors text[];
  v_behavioral_anchors text[];
  v_total_questions integer;
  v_resume_target integer;
  v_job_target integer;
  v_behavioral_target integer;
  v_resume_remaining integer;
  v_job_remaining integer;
  v_behavioral_remaining integer;
  v_source_plan text[] := '{}'::text[];
  v_used_keys text[] := '{}'::text[];
  v_source_type text;
  v_anchor text;
  v_phase text;
  v_question_text text;
  v_question_key text;
  v_skill_id uuid;
  v_order integer;
  v_resume_index integer := 0;
  v_job_index integer := 0;
  v_behavioral_index integer := 0;
  v_anchor_count integer;
  v_try integer;
  v_created_count integer := 0;
begin
  if p_force_regenerate then
    select count(*)
      into v_non_dynamic_count
    from public.interview_questions
    where interview_id = p_interview_id
      and coalesce(is_dynamic, false) = false;

    if v_non_dynamic_count = 0 then
      delete from public.interview_questions
      where interview_id = p_interview_id;
    else
      delete from public.interview_questions
      where interview_id = p_interview_id
        and coalesce(is_dynamic, false) = true;
    end if;
  end if;

  select count(*)
    into v_existing_count
  from public.interview_questions
  where interview_id = p_interview_id;

  if v_existing_count > 0 then
    return 0;
  end if;

  perform public.ensure_candidate_resume_profile(p_interview_id);

  select
    i.question_count,
    i.duration_minutes,
    public.clean_job_role_title(jp.job_title),
    coalesce(jp.core_skills, '{}'::text[]),
    jp.job_description
    into v_question_count,
         v_duration_minutes,
         v_role_title,
         v_job_skills,
         v_job_description
  from public.interviews i
  join public.job_positions jp
    on jp.job_id = i.job_id
  where i.interview_id = p_interview_id
  limit 1;

  if v_role_title is null and v_job_skills is null then
    return 0;
  end if;

  select coalesce(
           array_agg(distinct coalesce(sm.skill_name, sm.skill_code))
             filter (where nullif(trim(coalesce(sm.skill_name, sm.skill_code)), '') is not null),
           '{}'::text[]
         )
    into v_interview_skills
  from public.interview_skill_map ism
  join public.skill_master sm
    on sm.skill_id = ism.skill_id
  where ism.interview_id = p_interview_id;

  v_job_responsibilities := public.extract_job_description_anchors(v_job_description);

  select
    coalesce(cra.extracted_skills, '{}'::text[]),
    coalesce(cra.extracted_claims, '[]'::jsonb),
    cra.claimed_experience_years
    into v_resume_skills,
         v_resume_claims,
         v_resume_years
  from public.candidate_resume_ai cra
  where cra.interview_id = p_interview_id
  order by cra.created_at desc nulls last, cra.resume_ai_id desc
  limit 1;

  v_claim_anchors := public.extract_claim_anchors(v_resume_claims);
  v_resume_anchors := public.dedupe_text_array(
    coalesce(v_resume_skills, '{}'::text[]) || coalesce(v_claim_anchors, '{}'::text[])
  );
  v_overlap_anchors := public.compute_overlap_skills(
    v_resume_anchors,
    coalesce(v_job_skills, '{}'::text[]) || coalesce(v_interview_skills, '{}'::text[])
  );
  v_resume_anchors := public.dedupe_text_array(
    coalesce(v_overlap_anchors, '{}'::text[]) || coalesce(v_resume_anchors, '{}'::text[])
  );

  if v_resume_years is not null then
    v_resume_anchors := public.dedupe_text_array(
      v_resume_anchors || array[format('%s years of experience', v_resume_years)]
    );
  end if;

  if coalesce(array_length(v_resume_anchors, 1), 0) = 0 and public.normalize_seed_text(v_role_title) is not null then
    v_resume_anchors := array[public.normalize_seed_text(v_role_title)];
  end if;

  v_job_anchors := public.dedupe_text_array(
    coalesce(v_overlap_anchors, '{}'::text[]) ||
    coalesce(v_job_skills, '{}'::text[]) ||
    coalesce(v_job_responsibilities, '{}'::text[]) ||
    coalesce(v_interview_skills, '{}'::text[]) ||
    case
      when public.normalize_seed_text(v_role_title) is not null then array[public.normalize_seed_text(v_role_title)]
      else '{}'::text[]
    end
  );

  v_behavioral_anchors := public.dedupe_text_array(
    coalesce(v_overlap_anchors, '{}'::text[]) ||
    coalesce(v_job_responsibilities, '{}'::text[]) ||
    coalesce(v_interview_skills, '{}'::text[]) ||
    coalesce(v_job_skills, '{}'::text[]) ||
    case
      when public.normalize_seed_text(v_role_title) is not null then array[public.normalize_seed_text(v_role_title)]
      else '{}'::text[]
    end
  );

  v_total_questions := public.derive_effective_question_target(v_duration_minutes, v_question_count);

  select resume_count, job_count, behavioral_count
    into v_resume_target, v_job_target, v_behavioral_target
  from public.build_question_distribution(
    v_total_questions,
    coalesce(array_length(v_resume_skills, 1), 0) > 0
      or coalesce(array_length(v_claim_anchors, 1), 0) > 0
      or v_resume_years is not null
  );

  v_resume_remaining := greatest(coalesce(v_resume_target, 0), 0);
  v_job_remaining := greatest(coalesce(v_job_target, 0), 0);
  v_behavioral_remaining := greatest(coalesce(v_behavioral_target, 0), 0);

  while coalesce(array_length(v_source_plan, 1), 0) < v_total_questions loop
    if v_resume_remaining > 0 then
      v_source_plan := array_append(v_source_plan, 'resume');
      v_resume_remaining := v_resume_remaining - 1;
    end if;

    if v_job_remaining > 0 then
      v_source_plan := array_append(v_source_plan, 'job');
      v_job_remaining := v_job_remaining - 1;
    end if;

    if v_job_remaining > 0 then
      v_source_plan := array_append(v_source_plan, 'job');
      v_job_remaining := v_job_remaining - 1;
    end if;

    if v_behavioral_remaining > 0 then
      v_source_plan := array_append(v_source_plan, 'behavioral');
      v_behavioral_remaining := v_behavioral_remaining - 1;
    end if;
  end loop;

  for v_order in 1..coalesce(array_length(v_source_plan, 1), 0) loop
    v_source_type := v_source_plan[v_order];
    v_phase := public.derive_seed_phase(v_order, v_total_questions);

    if v_source_type = 'resume' then
      v_anchor_count := greatest(coalesce(array_length(v_resume_anchors, 1), 0), 1);
      v_resume_index := v_resume_index + 1;
      v_anchor := coalesce(v_resume_anchors[((v_resume_index - 1) % v_anchor_count) + 1], public.normalize_seed_text(v_role_title), 'your recent background');
    elsif v_source_type = 'behavioral' then
      v_anchor_count := greatest(coalesce(array_length(v_behavioral_anchors, 1), 0), 1);
      v_behavioral_index := v_behavioral_index + 1;
      v_anchor := coalesce(v_behavioral_anchors[((v_behavioral_index - 1) % v_anchor_count) + 1], public.normalize_seed_text(v_role_title), 'a critical responsibility in this role');
    else
      v_anchor_count := greatest(coalesce(array_length(v_job_anchors, 1), 0), 1);
      v_job_index := v_job_index + 1;
      v_anchor := coalesce(v_job_anchors[((v_job_index - 1) % v_anchor_count) + 1], public.normalize_seed_text(v_role_title), 'the core responsibilities of this role');
    end if;

    v_question_text := null;
    v_question_key := null;

    for v_try in 0..5 loop
      v_question_text := public.build_seed_question_text(
        v_source_type,
        v_role_title,
        v_anchor,
        case v_source_type
          when 'resume' then v_resume_index + v_try - 1
          when 'behavioral' then v_behavioral_index + v_try - 1
          else v_job_index + v_try - 1
        end
      );
      v_question_key := public.normalize_question_memory_key(v_question_text);

      exit when not (v_question_key = any(v_used_keys));
    end loop;

    if v_question_key is null or v_question_key = any(v_used_keys) then
      continue;
    end if;

    v_used_keys := array_append(v_used_keys, v_question_key);
    v_skill_id := public.resolve_seed_skill_id(p_interview_id, v_anchor);

    insert into public.interview_questions (
      interview_id,
      question_id,
      question_order,
      is_mandatory,
      allow_follow_up,
      question_text,
      question_type,
      source_type,
      reference_context,
      is_dynamic,
      phase_hint,
      difficulty_level,
      target_skill_id
    )
    values (
      p_interview_id,
      null,
      v_order,
      true,
      true,
      v_question_text,
      case when v_source_type = 'behavioral' then 'behavioral' else 'open_ended' end,
      v_source_type,
      jsonb_build_object(
        'anchor', v_anchor,
        'distribution_slot', v_source_type,
        'memory_key', v_question_key,
        'seeded_by', 'interview_auto_seed_orchestration_patch'
      ),
      true,
      v_phase,
      case
        when v_source_type = 'job' and v_phase in ('probe', 'closing') then 4
        when v_source_type = 'behavioral' and v_phase in ('probe', 'closing') then 4
        else 3
      end,
      v_skill_id
    );

    v_created_count := v_created_count + 1;
  end loop;

  return v_created_count;
end;
$$;

create or replace function public.ensure_interview_prepared(
  p_interview_id uuid,
  p_force_regenerate_questions boolean default false
)
returns integer
language plpgsql
as $$
begin
  perform public.ensure_candidate_resume_profile(p_interview_id);
  return public.ensure_interview_questions_seeded(p_interview_id, p_force_regenerate_questions);
end;
$$;

create or replace function public.trg_prepare_interview_on_insert()
returns trigger
language plpgsql
as $$
begin
  perform public.ensure_interview_prepared(new.interview_id, false);
  return new;
end;
$$;

drop trigger if exists trg_prepare_interview_on_insert on public.interviews;

create trigger trg_prepare_interview_on_insert
after insert on public.interviews
for each row
execute function public.trg_prepare_interview_on_insert();

create or replace function public.trg_refresh_questions_from_resume()
returns trigger
language plpgsql
as $$
begin
  if new.interview_id is not null then
    perform public.ensure_interview_prepared(new.interview_id, true);
  end if;

  return new;
end;
$$;

drop trigger if exists trg_refresh_questions_from_resume on public.candidate_resume_ai;

create trigger trg_refresh_questions_from_resume
after insert or update of raw_resume, extracted_skills, extracted_claims, claimed_experience_years
on public.candidate_resume_ai
for each row
execute function public.trg_refresh_questions_from_resume();

create or replace function public.trg_refresh_questions_from_skill_map()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.interview_id is not null then
      perform public.ensure_interview_prepared(old.interview_id, true);
    end if;

    return old;
  end if;

  if new.interview_id is not null then
    perform public.ensure_interview_prepared(new.interview_id, true);
  end if;

  return new;
end;
$$;

drop trigger if exists trg_refresh_questions_from_skill_map on public.interview_skill_map;

create trigger trg_refresh_questions_from_skill_map
after insert or update or delete
on public.interview_skill_map
for each row
execute function public.trg_refresh_questions_from_skill_map();

do $$
declare
  v_interview_id uuid;
begin
  for v_interview_id in
    select i.interview_id
    from public.interviews i
  loop
    perform public.ensure_interview_prepared(v_interview_id, false);
  end loop;
end;
$$;
