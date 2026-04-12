alter table public.interview_attempts
  add column if not exists current_phase text,
  add column if not exists difficulty_level integer,
  add column if not exists adaptive_state jsonb default '{}'::jsonb,
  add column if not exists last_answer_score numeric;

update public.interview_attempts
set current_phase = coalesce(current_phase, 'warmup'),
    difficulty_level = coalesce(difficulty_level, 3),
    adaptive_state = coalesce(adaptive_state, '{}'::jsonb)
where current_phase is null
   or difficulty_level is null
   or adaptive_state is null;

do $$
begin
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
end $$;
