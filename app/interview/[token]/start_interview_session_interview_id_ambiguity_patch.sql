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
  where public.interview_invites.token = trim(p_token)
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
  where public.interviews.interview_id = v_invite.interview_id;

  if not found then
    raise exception 'Interview not found';
  end if;

  select *
  into v_latest_attempt
  from public.interview_attempts
  where public.interview_attempts.interview_id = v_invite.interview_id
  order by public.interview_attempts.attempt_number desc, public.interview_attempts.started_at desc
  limit 1;

  if found and lower(coalesce(v_latest_attempt.status, '')) = 'started' then
    return query
    select
      v_latest_attempt.attempt_id,
      v_latest_attempt.interview_id,
      v_latest_attempt.attempt_number,
      true;
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
  returning
    public.interview_attempts.attempt_id,
    public.interview_attempts.interview_id,
    public.interview_attempts.attempt_number
  into attempt_id, interview_id, attempt_number;

  update public.interview_invites
  set attempts_used = coalesce(public.interview_invites.attempts_used, 0) + 1,
      used_at = now()
  where public.interview_invites.invite_id = v_invite.invite_id;

  reused := false;
  return next;
end;
$$;

grant all on function public.start_interview_session(text) to anon, authenticated, service_role;
