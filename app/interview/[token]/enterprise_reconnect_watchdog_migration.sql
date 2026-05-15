begin;

alter table public.interview_attempts
  add column if not exists last_activity_at timestamptz,
  add column if not exists inactivity_seconds integer,
  add column if not exists disconnect_reason text,
  add column if not exists reconnect_count integer not null default 0,
  add column if not exists reconnect_events jsonb not null default '[]'::jsonb,
  add column if not exists total_disconnect_duration integer not null default 0,
  add column if not exists recovered_successfully boolean not null default false,
  add column if not exists last_disconnect_at timestamptz,
  add column if not exists last_reconnect_at timestamptz;

update public.interview_attempts
set last_activity_at = coalesce(last_activity_at, started_at, created_at, now()),
    reconnect_count = coalesce(reconnect_count, 0),
    reconnect_events = coalesce(reconnect_events, '[]'::jsonb),
    total_disconnect_duration = coalesce(total_disconnect_duration, 0),
    recovered_successfully = coalesce(recovered_successfully, false)
where last_activity_at is null
   or reconnect_count is null
   or reconnect_events is null
   or total_disconnect_duration is null
   or recovered_successfully is null;

create index if not exists idx_interview_attempts_status_last_activity
  on public.interview_attempts (status, last_activity_at);

create index if not exists idx_interview_attempts_last_disconnect
  on public.interview_attempts (last_disconnect_at);

commit;
