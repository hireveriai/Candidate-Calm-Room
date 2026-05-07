alter table if exists public.interviews
  add column if not exists recovery_allowed boolean not null default true,
  add column if not exists recovery_used boolean not null default false,
  add column if not exists final_status text,
  add column if not exists forensic_timeline_id uuid,
  alter column max_attempts set default 2;

update public.interviews
set max_attempts = greatest(coalesce(max_attempts, 1), 2)
where max_attempts is null or max_attempts < 2;

alter table if exists public.interview_attempts
  add column if not exists interruption_reason text,
  add column if not exists interruption_detected_at timestamptz,
  add column if not exists transcript_status text not null default 'PENDING',
  add column if not exists recording_status text not null default 'PENDING',
  add column if not exists timer_remaining_seconds integer,
  add column if not exists inherited_from_attempt_id uuid references public.interview_attempts(attempt_id),
  add column if not exists recovery_link_issued_at timestamptz,
  add column if not exists recovery_link_expires_at timestamptz,
  add column if not exists recovery_decision text,
  add column if not exists recovery_decided_by uuid,
  add column if not exists recovery_decided_at timestamptz,
  add column if not exists recovery_token_hash text,
  add column if not exists recovery_token_used_at timestamptz,
  add column if not exists recovery_policy jsonb not null default '{}'::jsonb;

create table if not exists public.interview_recovery_events (
  recovery_event_id uuid primary key default gen_random_uuid(),
  interview_id uuid not null references public.interviews(interview_id) on delete cascade,
  attempt_id uuid references public.interview_attempts(attempt_id) on delete set null,
  inherited_from_attempt_id uuid references public.interview_attempts(attempt_id) on delete set null,
  event_type text not null,
  classifier text,
  reason text,
  source text not null default 'system',
  idempotency_key text,
  occurred_at timestamptz not null default now(),
  actor_id uuid,
  metadata jsonb not null default '{}'::jsonb
);

create unique index if not exists ux_recovery_events_idempotency
  on public.interview_recovery_events(interview_id, idempotency_key)
  where idempotency_key is not null;

create unique index if not exists ux_interview_active_recovery_token
  on public.interview_attempts(recovery_token_hash)
  where recovery_token_hash is not null and recovery_token_used_at is null;

create index if not exists idx_recovery_events_interview_time
  on public.interview_recovery_events(interview_id, occurred_at desc);

create index if not exists idx_attempts_recovery_parent
  on public.interview_attempts(inherited_from_attempt_id);
