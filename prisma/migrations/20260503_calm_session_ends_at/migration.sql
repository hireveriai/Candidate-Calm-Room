alter table public.interview_attempts
  add column if not exists ends_at timestamptz;

update public.interview_attempts ia
set ends_at = ia.started_at + make_interval(mins => coalesce(i.duration_minutes, 30))
from public.interviews i
where i.interview_id = ia.interview_id
  and ia.ends_at is null;

alter table public.interview_attempts
  alter column ends_at set default (now() + interval '30 minutes');

create index if not exists idx_interview_attempts_ends_at
  on public.interview_attempts (ends_at);
