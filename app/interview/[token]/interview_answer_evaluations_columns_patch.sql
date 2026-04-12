begin;

alter table public.interview_answer_evaluations
  add column if not exists skill_id uuid,
  add column if not exists skill_score numeric,
  add column if not exists clarity_score numeric,
  add column if not exists depth_score numeric,
  add column if not exists confidence_score numeric,
  add column if not exists fraud_score numeric,
  add column if not exists evaluation_json jsonb default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'fk_interview_answer_evaluations_skill'
  ) then
    alter table public.interview_answer_evaluations
      add constraint fk_interview_answer_evaluations_skill
      foreign key (skill_id)
      references public.skill_master(skill_id)
      on delete set null;
  end if;
end $$;

create index if not exists idx_interview_answer_evaluations_skill_id
  on public.interview_answer_evaluations (skill_id);

create index if not exists idx_interview_answer_evaluations_answer_ai
  on public.interview_answer_evaluations (answer_id, evaluator_type);

commit;
