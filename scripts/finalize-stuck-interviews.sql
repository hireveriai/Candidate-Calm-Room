-- Finalize currently stuck HireVeri Calm interview attempts.
--
-- What it fixes:
-- - Browser/tab closed but attempt stayed STARTED / IN_PROGRESS / RECONNECTING.
-- - Interview duration elapsed, plus a 10 minute buffer, but attempt stayed active.
-- - Parent recruiter interview still appears as Started.
--
-- Optional targeting:
--   Add filters in the candidate_attempts CTE, for example:
--     and i.organization_id = '00000000-0000-0000-0000-000000000000'::uuid
--     and i.interview_id = '00000000-0000-0000-0000-000000000000'::uuid

begin;

with settings as (
  select
    300::int as stale_heartbeat_seconds,
    600::int as session_end_buffer_seconds
),
candidate_attempts as (
  select
    ia.attempt_id,
    ia.interview_id,
    ia.status,
    ia.started_at,
    ia.last_activity_at,
    ia.ends_at,
    case
      when ia.ends_at is not null
        and ia.ends_at < now() - (settings.session_end_buffer_seconds * interval '1 second')
        then 'TIME_EXPIRED'
      else 'ABANDONED'
    end as final_attempt_status,
    case
      when ia.ends_at is not null
        and ia.ends_at < now() - (settings.session_end_buffer_seconds * interval '1 second')
        then 'timeout'
      else 'watchdog_timeout'
    end as termination_type,
    case
      when ia.ends_at is not null
        and ia.ends_at < now() - (settings.session_end_buffer_seconds * interval '1 second')
        then 'session_time_expired'
      else 'heartbeat_timeout'
    end as disconnect_reason
  from public.interview_attempts ia
  inner join public.interviews i
    on i.interview_id = ia.interview_id
  cross join settings
  where upper(coalesce(ia.status, '')) in (
      'STARTED',
      'IN_PROGRESS',
      'RECONNECTING',
      'QUESTION_ACTIVE',
      'ANSWER_RECORDING',
      'ANSWER_PROCESSING',
      'QUESTION_GENERATING',
      'FOLLOWUP_GENERATING',
      'READY',
      'CREATED',
      'RECOVERY_USED',
      'INTERRUPTED'
    )
    and (
      (
        ia.ends_at is not null
        and ia.ends_at < now() - (settings.session_end_buffer_seconds * interval '1 second')
      )
      or (
        coalesce(ia.last_activity_at, ia.started_at) < now() - (settings.stale_heartbeat_seconds * interval '1 second')
      )
    )
),
finalized_attempts as (
  update public.interview_attempts ia
  set status = ca.final_attempt_status,
      ended_at = coalesce(ia.ended_at, least(now(), coalesce(ia.ends_at, now()))),
      termination_type = ca.termination_type,
      disconnect_reason = ca.disconnect_reason,
      termination_detected_at = coalesce(ia.termination_detected_at, now()),
      recovered_successfully = false,
      early_exit = case
        when ca.final_attempt_status = 'TIME_EXPIRED' then ia.early_exit
        else true
      end,
      inactivity_seconds = case
        when ca.final_attempt_status = 'TIME_EXPIRED' then
          greatest(extract(epoch from (now() - coalesce(ia.ends_at, now())))::int, 0)
        else greatest(extract(epoch from (now() - coalesce(ia.last_activity_at, ia.started_at)))::int, 0)
      end
  from candidate_attempts ca
  where ia.attempt_id = ca.attempt_id
  returning ia.attempt_id, ia.interview_id, ia.status
),
closed_recordings as (
  update public.interview_recordings ir
  set status = case
        when coalesce(ir.status, 'recording') = 'failed' then ir.status
        else 'completed'
      end,
      ended_at = coalesce(ir.ended_at, timezone('utc', now()))
  from finalized_attempts fa
  where ir.attempt_id = fa.attempt_id
    and ir.ended_at is null
  returning ir.recording_id
),
closed_interviews as (
  select distinct fa.interview_id, fa.status as final_status
  from finalized_attempts fa
  where not exists (
    select 1
    from public.interview_attempts active
    where active.interview_id = fa.interview_id
      and active.attempt_id <> fa.attempt_id
      and upper(coalesce(active.status, '')) in (
        'STARTED',
        'IN_PROGRESS',
        'RECONNECTING',
        'QUESTION_ACTIVE',
        'ANSWER_RECORDING',
        'ANSWER_PROCESSING',
        'QUESTION_GENERATING',
        'FOLLOWUP_GENERATING',
        'READY',
        'CREATED',
        'RECOVERY_USED',
        'INTERRUPTED'
      )
  )
),
updated_interviews as (
  update public.interviews i
  set status = 'COMPLETED',
      final_status = coalesce(i.final_status, ci.final_status)
  from closed_interviews ci
  where i.interview_id = ci.interview_id
  returning i.interview_id, i.status, i.final_status
)
select
  (select count(*) from finalized_attempts) as finalized_attempts,
  (select count(*) from updated_interviews) as updated_interviews,
  (select count(*) from closed_recordings) as closed_recordings;

commit;
