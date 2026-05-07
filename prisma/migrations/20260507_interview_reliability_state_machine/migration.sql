create extension if not exists pgcrypto;

do $$
begin
  with ranked as (
    select
      session_question_id,
      attempt_id,
      question_order,
      row_number() over (
        partition by attempt_id, question_order
        order by asked_at asc nulls last, session_question_id asc
      ) as duplicate_rank,
      max(question_order) over (partition by attempt_id) as max_order
    from public.session_questions
    where question_order is not null
  )
  update public.session_questions sq
  set question_order = ranked.max_order + ranked.duplicate_rank - 1
  from ranked
  where sq.session_question_id = ranked.session_question_id
    and ranked.duplicate_rank > 1;

  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and indexname = 'uq_session_questions_attempt_order'
  ) then
    create unique index uq_session_questions_attempt_order
      on public.session_questions (attempt_id, question_order);
  end if;
end $$;

create index if not exists idx_interview_answers_attempt_session_status
  on public.interview_answers (attempt_id, session_question_id, status);

create index if not exists idx_interview_attempts_timer_status
  on public.interview_attempts (status, ends_at);

create index if not exists idx_interview_signals_attempt_type_created
  on public.interview_signals (attempt_id, type, created_at desc);

create table if not exists public.interview_timeline_events (
  event_id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null,
  interview_id uuid,
  organization_id uuid,
  event_type text not null,
  sequence_number integer,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_interview_timeline_events_attempt_created
  on public.interview_timeline_events (attempt_id, created_at asc, event_id asc);
