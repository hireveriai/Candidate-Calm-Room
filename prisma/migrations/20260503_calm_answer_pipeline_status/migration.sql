alter table public.interview_answers
  add column if not exists status text not null default 'completed';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_interview_answers_status'
  ) then
    alter table public.interview_answers
      add constraint chk_interview_answers_status
      check (status in ('generating', 'completed', 'failed'));
  end if;
end $$;

create index if not exists idx_interview_answers_status
  on public.interview_answers (status);

drop function if exists public.submit_interview_answer(uuid, text, integer);
drop function if exists public.submit_interview_answer(uuid, text, integer, jsonb);
drop function if exists public.submit_coding_answer(uuid, text, text, integer);
