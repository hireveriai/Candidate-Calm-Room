begin;

alter table public.interview_attempts
  add column if not exists termination_type text,
  add column if not exists termination_detected_at timestamptz,
  add column if not exists termination_phase text,
  add column if not exists time_elapsed_seconds integer,
  add column if not exists questions_answered integer not null default 0,
  add column if not exists expected_questions integer,
  add column if not exists completion_percentage numeric(5,4),
  add column if not exists reliability_score numeric(5,2),
  add column if not exists early_exit boolean not null default false,
  add column if not exists termination_metadata jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_interview_attempts_termination_type'
  ) then
    alter table public.interview_attempts
      add constraint chk_interview_attempts_termination_type
      check (
        termination_type is null or
        termination_type in ('manual_exit', 'tab_close', 'disconnect', 'timeout')
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_interview_attempts_completion_percentage'
  ) then
    alter table public.interview_attempts
      add constraint chk_interview_attempts_completion_percentage
      check (
        completion_percentage is null or
        (completion_percentage >= 0 and completion_percentage <= 1)
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_interview_attempts_reliability_score'
  ) then
    alter table public.interview_attempts
      add constraint chk_interview_attempts_reliability_score
      check (
        reliability_score is null or
        (reliability_score >= 0 and reliability_score <= 100)
      );
  end if;
end $$;

create index if not exists idx_interview_attempts_termination_type
  on public.interview_attempts (termination_type);

commit;
