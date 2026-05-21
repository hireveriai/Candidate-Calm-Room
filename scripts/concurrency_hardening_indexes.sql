-- HireVeri concurrency and scalability hardening
-- Review and apply during a maintenance window. All objects are idempotent.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '2min';

-- Prevent duplicate answer rows for dynamic/follow-up session questions.
create table if not exists public.interview_answer_duplicate_quarantine (
  quarantine_id uuid primary key default gen_random_uuid(),
  answer_id uuid not null,
  attempt_id uuid,
  question_id uuid,
  session_question_id uuid,
  answer_text text,
  answer_payload jsonb,
  answered_at timestamptz,
  status text,
  quarantined_at timestamptz not null default timezone('utc', now()),
  reason text not null
);

with ranked_answers as (
  select
    answer_id,
    attempt_id,
    question_id,
    session_question_id,
    answer_text,
    answer_payload,
    answered_at,
    status,
    row_number() over (
      partition by session_question_id
      order by
        case when lower(coalesce(status, '')) = 'completed' then 0 else 1 end,
        case when nullif(trim(coalesce(answer_text, '')), '') is not null then 0 else 1 end,
        answered_at desc nulls last,
        answer_id desc
    ) as duplicate_rank
  from public.interview_answers
  where session_question_id is not null
),
duplicates as (
  select *
  from ranked_answers
  where duplicate_rank > 1
)
insert into public.interview_answer_duplicate_quarantine (
  answer_id,
  attempt_id,
  question_id,
  session_question_id,
  answer_text,
  answer_payload,
  answered_at,
  status,
  reason
)
select
  answer_id,
  attempt_id,
  question_id,
  session_question_id,
  answer_text,
  answer_payload,
  answered_at,
  status,
  'duplicate session_question_id before ux_interview_answers_session_question'
from duplicates
where not exists (
  select 1
  from public.interview_answer_duplicate_quarantine q
  where q.answer_id = duplicates.answer_id
);

delete from public.interview_answers ia
using (
  select answer_id
  from (
    select
      answer_id,
      row_number() over (
        partition by session_question_id
        order by
          case when lower(coalesce(status, '')) = 'completed' then 0 else 1 end,
          case when nullif(trim(coalesce(answer_text, '')), '') is not null then 0 else 1 end,
          answered_at desc nulls last,
          answer_id desc
      ) as duplicate_rank
    from public.interview_answers
    where session_question_id is not null
  ) ranked
  where duplicate_rank > 1
) duplicates
where ia.answer_id = duplicates.answer_id;

create unique index if not exists ux_interview_answers_session_question
  on public.interview_answers(session_question_id)
  where session_question_id is not null;

-- Fast idempotency and answer status lookups.
create index if not exists idx_interview_answers_session_status
  on public.interview_answers(session_question_id, status, answered_at desc)
  where session_question_id is not null;

-- Completion/report aggregate paths.
create index if not exists idx_interview_answer_evaluations_answer_type
  on public.interview_answer_evaluations(answer_id, evaluator_type);

create index if not exists idx_interview_attempts_interview_started
  on public.interview_attempts(interview_id, started_at desc, attempt_number desc);

create index if not exists idx_interview_attempts_last_activity_active
  on public.interview_attempts(last_activity_at)
  where upper(coalesce(status, '')) not in ('FINALIZED', 'COMPLETED', 'TERMINATED', 'ABANDONED', 'EXPIRED', 'FAILED');

-- Telemetry and reconnect/report paths.
create index if not exists idx_interview_signals_attempt_created
  on public.interview_signals(attempt_id, created_at desc);

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'interview_signals'
      and column_name = 'interview_id'
  ) then
    create index if not exists idx_interview_signals_interview_created
      on public.interview_signals(interview_id, created_at desc)
      where interview_id is not null;
  end if;
end $$;

create index if not exists idx_forensic_transcripts_attempt_segment
  on public.forensic_transcripts(attempt_id, segment_index);

create index if not exists idx_interview_recordings_attempt_created
  on public.interview_recordings(attempt_id, created_at desc)
  where attempt_id is not null;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'interview_recordings'
      and column_name = 'interview_id'
  ) then
    create index if not exists idx_interview_recordings_interview_created
      on public.interview_recordings(interview_id, created_at desc)
      where interview_id is not null;
  end if;
end $$;

-- Recruiter dashboard/report tenant filters.
create index if not exists idx_interviews_org_status_created
  on public.interviews(organization_id, status, created_at desc);

create index if not exists idx_interviews_org_candidate
  on public.interviews(organization_id, candidate_id);

create index if not exists idx_interviews_org_job
  on public.interviews(organization_id, job_id);

create index if not exists idx_interview_invites_interview_created
  on public.interview_invites(interview_id, created_at desc);

create index if not exists idx_interview_invites_token_active
  on public.interview_invites(token)
  where status = 'ACTIVE';

create index if not exists idx_candidates_org_created
  on public.candidates(organization_id, created_at desc);

create index if not exists idx_job_positions_org_created
  on public.job_positions(organization_id, created_at desc);

-- Recovery and state-machine lookup paths.
do $$
begin
  if to_regclass('public.interview_recovery_events') is not null
     and exists (
       select 1
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'interview_recovery_events'
         and column_name = 'attempt_id'
     )
     and exists (
       select 1
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'interview_recovery_events'
         and column_name = 'occurred_at'
     ) then
    create index if not exists idx_recovery_events_attempt_time
      on public.interview_recovery_events(attempt_id, occurred_at desc)
      where attempt_id is not null;
  end if;
end $$;

create index if not exists idx_session_questions_attempt_asked
  on public.session_questions(attempt_id, asked_at desc, session_question_id);

commit;

-- Pooling recommendations:
-- Candidate calm room: set PG_POOL_MAX=5 to 10 per app instance when using PgBouncer/Supabase pooler.
-- Recruiter Prisma URL: set connection_limit=5 per app instance, not 1, after validating DB max_connections.
-- Recruiter raw pg pool: set max=5 per app instance.
-- Keep total app-side max connections below 70 percent of the database/pooler hard limit.
