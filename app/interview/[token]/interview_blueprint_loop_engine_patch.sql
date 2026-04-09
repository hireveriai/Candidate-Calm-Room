alter table public.interview_attempts
  add column if not exists current_phase text not null default 'warmup',
  add column if not exists difficulty_level integer not null default 3,
  add column if not exists interview_blueprint jsonb not null default '{}'::jsonb;

alter table public.interviews
  add column if not exists required_follow_up_questions integer not null default 2;

update public.interviews
set required_follow_up_questions = coalesce(
  required_follow_up_questions,
  least(coalesce(question_count, 2), 2)
);

alter table public.interview_questions
  alter column question_id drop not null;

alter table public.interview_questions
  add column if not exists allow_follow_up boolean not null default true,
  add column if not exists question_text text,
  add column if not exists question_type text,
  add column if not exists source_type text,
  add column if not exists reference_context jsonb not null default '{}'::jsonb,
  add column if not exists is_dynamic boolean not null default false,
  add column if not exists phase_hint text not null default 'core',
  add column if not exists difficulty_level integer not null default 3,
  add column if not exists target_skill_id uuid;

alter table public.session_questions
  add column if not exists parent_session_question_id uuid,
  add column if not exists question_kind text,
  add column if not exists question_order integer,
  add column if not exists source_context jsonb not null default '{}'::jsonb,
  add column if not exists mapped_skill_id uuid,
  add column if not exists phase text not null default 'core',
  add column if not exists difficulty_level integer not null default 3,
  add column if not exists probe_type text,
  add column if not exists contradiction_probe boolean not null default false;

update public.session_questions
set question_kind = coalesce(question_kind, 'core')
where question_kind is null;

with ranked as (
  select
    session_question_id,
    row_number() over (
      partition by attempt_id
      order by asked_at asc nulls last, session_question_id asc
    ) as seq
  from public.session_questions
)
update public.session_questions sq
set question_order = ranked.seq
from ranked
where ranked.session_question_id = sq.session_question_id
  and sq.question_order is null;

alter table public.session_questions
  alter column question_kind set default 'core';

create index if not exists idx_interview_questions_source_type
  on public.interview_questions (interview_id, source_type);

create index if not exists idx_interview_questions_target_skill
  on public.interview_questions (interview_id, target_skill_id);

create index if not exists idx_session_questions_mapped_skill
  on public.session_questions (attempt_id, mapped_skill_id);

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'chk_session_questions_question_kind'
  ) then
    alter table public.session_questions
      drop constraint chk_session_questions_question_kind;
  end if;

  alter table public.session_questions
    add constraint chk_session_questions_question_kind
    check (question_kind in ('core', 'follow_up', 'closing'));

  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_interviews_required_follow_up_questions_non_negative'
  ) then
    alter table public.interviews
      add constraint chk_interviews_required_follow_up_questions_non_negative
      check (required_follow_up_questions >= 0);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_interviews_follow_up_question_budget'
  ) then
    alter table public.interviews
      add constraint chk_interviews_follow_up_question_budget
      check (question_count is null or required_follow_up_questions <= question_count);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_interview_attempts_current_phase'
  ) then
    alter table public.interview_attempts
      add constraint chk_interview_attempts_current_phase
      check (current_phase in ('warmup', 'core', 'probe', 'closing'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_interview_attempts_difficulty_level'
  ) then
    alter table public.interview_attempts
      add constraint chk_interview_attempts_difficulty_level
      check (difficulty_level between 1 and 5);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_interview_questions_source_type'
  ) then
    alter table public.interview_questions
      add constraint chk_interview_questions_source_type
      check (source_type is null or source_type in ('resume', 'job', 'behavioral'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_interview_questions_phase_hint'
  ) then
    alter table public.interview_questions
      add constraint chk_interview_questions_phase_hint
      check (phase_hint in ('warmup', 'core', 'probe', 'closing'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_interview_questions_difficulty_level'
  ) then
    alter table public.interview_questions
      add constraint chk_interview_questions_difficulty_level
      check (difficulty_level between 1 and 5);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_session_questions_phase'
  ) then
    alter table public.session_questions
      add constraint chk_session_questions_phase
      check (phase in ('warmup', 'core', 'probe', 'closing'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_session_questions_difficulty_level'
  ) then
    alter table public.session_questions
      add constraint chk_session_questions_difficulty_level
      check (difficulty_level between 1 and 5);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'fk_interview_questions_target_skill'
  ) then
    alter table public.interview_questions
      add constraint fk_interview_questions_target_skill
      foreign key (target_skill_id)
      references public.skill_master(skill_id)
      on delete set null;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'fk_session_questions_mapped_skill'
  ) then
    alter table public.session_questions
      add constraint fk_session_questions_mapped_skill
      foreign key (mapped_skill_id)
      references public.skill_master(skill_id)
      on delete set null;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'fk_session_questions_parent'
  ) then
    alter table public.session_questions
      add constraint fk_session_questions_parent
      foreign key (parent_session_question_id)
      references public.session_questions(session_question_id)
      on delete set null;
  end if;
end $$;
