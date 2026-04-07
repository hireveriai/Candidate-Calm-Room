begin;

alter table public.job_positions
  add column if not exists coding_required text not null default 'AUTO',
  add column if not exists coding_assessment_type text,
  add column if not exists coding_difficulty text,
  add column if not exists coding_duration_minutes integer,
  add column if not exists coding_languages text[] not null default array[]::text[],
  add column if not exists coding_recommended boolean not null default false,
  add column if not exists coding_recommendation_reason text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_job_positions_coding_required'
  ) then
    alter table public.job_positions
      add constraint chk_job_positions_coding_required
      check (coding_required in ('NO', 'YES', 'AUTO'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_job_positions_coding_assessment_type'
  ) then
    alter table public.job_positions
      add constraint chk_job_positions_coding_assessment_type
      check (
        coding_assessment_type is null or
        coding_assessment_type in (
          'LIVE_CODING',
          'DEBUGGING',
          'SQL',
          'BACKEND_LOGIC',
          'DSA'
        )
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_job_positions_coding_difficulty'
  ) then
    alter table public.job_positions
      add constraint chk_job_positions_coding_difficulty
      check (
        coding_difficulty is null or
        coding_difficulty in ('EASY', 'MEDIUM', 'HARD')
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_job_positions_coding_duration'
  ) then
    alter table public.job_positions
      add constraint chk_job_positions_coding_duration
      check (
        coding_duration_minutes is null or
        coding_duration_minutes in (10, 15, 20, 30)
      );
  end if;
end $$;

create or replace function public.fn_recommend_coding_assessment(
  p_job_title text,
  p_job_description text,
  p_core_skills text[]
)
returns table (
  coding_recommended boolean,
  coding_assessment_type text,
  coding_recommendation_reason text
)
language plpgsql
as $$
declare
  v_blob text := lower(
    coalesce(p_job_title, '') || ' ' ||
    coalesce(p_job_description, '') || ' ' ||
    coalesce(array_to_string(p_core_skills, ' '), '')
  );
begin
  if v_blob ~ '(python|java|javascript|typescript|react|node|backend|frontend|full stack|fullstack|sql|postgres|mysql|api|microservice|debug|coding|developer|engineer|spark|airflow|kafka|etl|pipeline)' then
    coding_recommended := true;

    if v_blob ~ '(sql|postgres|mysql|query|warehouse)' then
      coding_assessment_type := 'SQL';
      coding_recommendation_reason := 'Role and skills indicate query-heavy implementation work.';
    elsif v_blob ~ '(debug|troubleshoot|fix|incident|production issue)' then
      coding_assessment_type := 'DEBUGGING';
      coding_recommendation_reason := 'Role emphasizes troubleshooting and hands-on debugging.';
    elsif v_blob ~ '(api|backend|microservice|node|java|spring|django|flask|golang|go)' then
      coding_assessment_type := 'BACKEND_LOGIC';
      coding_recommendation_reason := 'Role emphasizes backend implementation and service design.';
    else
      coding_assessment_type := 'LIVE_CODING';
      coding_recommendation_reason := 'Role appears implementation-heavy and should include a coding round.';
    end if;
  else
    coding_recommended := false;
    coding_assessment_type := null;
    coding_recommendation_reason := 'Role does not strongly indicate a coding round from title, JD, or core skills.';
  end if;

  return next;
end;
$$;

create or replace function public.fn_create_job(
  p_organization_id uuid,
  p_job_title text,
  p_job_description text,
  p_experience_level_id smallint,
  p_core_skills text[],
  p_difficulty_profile text,
  p_skill_baseline jsonb default '[]'::jsonb,
  p_coding_required text default 'AUTO',
  p_coding_assessment_type text default null,
  p_coding_difficulty text default null,
  p_coding_duration_minutes integer default null,
  p_coding_languages text[] default array[]::text[]
)
returns table (
  job_id uuid
)
language plpgsql
as $$
declare
  v_job_id uuid;
  v_coding_recommended boolean := false;
  v_recommended_type text := null;
  v_recommendation_reason text := null;
begin
  if not exists (
    select 1
    from public.experience_level_pool elp
    where elp.experience_level_id = p_experience_level_id
  ) then
    raise exception 'INVALID_EXPERIENCE_LEVEL: experience_level_id does not exist';
  end if;

  if p_coding_required not in ('NO', 'YES', 'AUTO') then
    raise exception 'INVALID_CODING_REQUIRED: coding_required must be NO, YES, or AUTO';
  end if;

  if p_coding_assessment_type is not null and p_coding_assessment_type not in ('LIVE_CODING', 'DEBUGGING', 'SQL', 'BACKEND_LOGIC', 'DSA') then
    raise exception 'INVALID_CODING_ASSESSMENT_TYPE: unsupported coding_assessment_type';
  end if;

  if p_coding_difficulty is not null and p_coding_difficulty not in ('EASY', 'MEDIUM', 'HARD') then
    raise exception 'INVALID_CODING_DIFFICULTY: coding_difficulty must be EASY, MEDIUM, or HARD';
  end if;

  if p_coding_duration_minutes is not null and p_coding_duration_minutes not in (10, 15, 20, 30) then
    raise exception 'INVALID_CODING_DURATION: coding_duration_minutes must be 10, 15, 20, or 30';
  end if;

  if p_skill_baseline is not null and jsonb_typeof(p_skill_baseline) = 'array' then
    if exists (
      select 1
      from jsonb_array_elements(p_skill_baseline) as baseline
      where coalesce((baseline ->> 'expected_level')::int, 0) < 1
         or coalesce((baseline ->> 'expected_level')::int, 0) > 4
    ) then
      raise exception 'INVALID_EXPECTED_LEVEL: expected_level must be between 1 and 4';
    end if;
  end if;

  select
    recommendation.coding_recommended,
    recommendation.coding_assessment_type,
    recommendation.coding_recommendation_reason
  into
    v_coding_recommended,
    v_recommended_type,
    v_recommendation_reason
  from public.fn_recommend_coding_assessment(
    p_job_title,
    p_job_description,
    coalesce(p_core_skills, array[]::text[])
  ) recommendation;

  if p_coding_required = 'YES' then
    v_coding_recommended := true;
    v_recommendation_reason := 'Recruiter explicitly enabled coding assessment.';
  elsif p_coding_required = 'NO' then
    v_coding_recommended := false;
    v_recommendation_reason := 'Recruiter explicitly disabled coding assessment.';
  end if;

  insert into public.job_positions (
    organization_id,
    job_title,
    job_description,
    experience_level_id,
    core_skills,
    difficulty_profile,
    coding_required,
    coding_assessment_type,
    coding_difficulty,
    coding_duration_minutes,
    coding_languages,
    coding_recommended,
    coding_recommendation_reason
  )
  values (
    p_organization_id,
    p_job_title,
    nullif(p_job_description, ''),
    p_experience_level_id,
    coalesce(p_core_skills, array[]::text[]),
    p_difficulty_profile,
    p_coding_required,
    coalesce(p_coding_assessment_type, v_recommended_type),
    p_coding_difficulty,
    p_coding_duration_minutes,
    coalesce(p_coding_languages, array[]::text[]),
    coalesce(v_coding_recommended, false),
    v_recommendation_reason
  )
  returning job_positions.job_id into v_job_id;

  if p_skill_baseline is not null and jsonb_typeof(p_skill_baseline) = 'array' and jsonb_array_length(p_skill_baseline) > 0 then
    insert into public.company_skill_baseline (
      organization_id,
      job_id,
      skill_domain,
      expected_level
    )
    select
      p_organization_id,
      v_job_id,
      baseline ->> 'skill_domain',
      (baseline ->> 'expected_level')::int
    from jsonb_array_elements(p_skill_baseline) as baseline;
  end if;

  return query select v_job_id;
exception
  when others then
    perform public.log_backend_error(
      'fn_create_job',
      sqlerrm,
      sqlstate,
      jsonb_build_object(
        'organization_id', p_organization_id,
        'job_title', p_job_title,
        'experience_level_id', p_experience_level_id,
        'coding_required', p_coding_required
      )
    );
    raise;
end;
$$;

commit;
