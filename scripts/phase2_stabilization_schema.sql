begin;

alter table if exists public.interview_answer_evaluations
  add column if not exists skill_score numeric(5,4),
  add column if not exists clarity_score numeric(5,4),
  add column if not exists depth_score numeric(5,4),
  add column if not exists confidence_score numeric(5,4),
  add column if not exists fraud_score numeric(5,4);

alter table if exists public.interview_attempts
  add column if not exists transcript_status text not null default 'PENDING',
  add column if not exists recording_status text not null default 'PENDING',
  add column if not exists termination_metadata jsonb not null default '{}'::jsonb,
  add column if not exists reliability_score numeric(5,2),
  add column if not exists completion_percentage numeric(5,4);

alter table if exists public.interview_attempts
  drop constraint if exists chk_interview_attempt_status;

alter table if exists public.interview_attempts
  add constraint chk_interview_attempt_status
  check (
    upper(status) in (
      'STARTED',
      'CREATED',
      'READY',
      'QUESTION_GENERATING',
      'QUESTION_ACTIVE',
      'ANSWER_RECORDING',
      'ANSWER_PROCESSING',
      'FOLLOWUP_GENERATING',
      'COMPLETING',
      'FINALIZING',
      'FINALIZED',
      'COMPLETED',
      'INTERRUPTED',
      'RECOVERY_ALLOWED',
      'RECOVERY_USED',
      'ABANDONED',
      'FAILED',
      'TIME_EXPIRED'
    )
  );

create index if not exists idx_session_questions_attempt_order_phase
  on public.session_questions (attempt_id, question_order, question_kind);

create index if not exists idx_interview_answers_attempt_answered_at
  on public.interview_answers (attempt_id, answered_at desc);

create index if not exists idx_interview_answer_evaluations_answer_type
  on public.interview_answer_evaluations (answer_id, evaluator_type);

create index if not exists idx_interview_recordings_attempt_status
  on public.interview_recordings (attempt_id, status);

create unique index if not exists ux_forensic_transcripts_attempt_segment
  on public.forensic_transcripts (attempt_id, segment_index);

commit;
