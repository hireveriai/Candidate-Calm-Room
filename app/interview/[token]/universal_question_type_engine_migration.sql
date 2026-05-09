-- Universal HireVeri question-type engine.
-- Backward compatible: existing rows are inferred without forcing old records into coding.

alter table if exists public.interview_questions
  add column if not exists question_type text,
  add column if not exists classifier_confidence numeric(5,4),
  add column if not exists recruiter_override boolean not null default false,
  add column if not exists rendering_mode text;

alter table if exists public.session_questions
  add column if not exists classifier_confidence numeric(5,4),
  add column if not exists recruiter_override boolean not null default false,
  add column if not exists rendering_mode text;

alter table if exists public.questions
  add column if not exists classifier_confidence numeric(5,4),
  add column if not exists recruiter_override boolean not null default false,
  add column if not exists rendering_mode text;

alter table if exists public.job_positions
  add column if not exists question_type_default text not null default 'AUTO';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chk_interview_questions_universal_type'
  ) then
    alter table public.interview_questions
      add constraint chk_interview_questions_universal_type
      check (
        question_type is null or question_type in (
          'coding',
          'technical_discussion',
          'system_design',
          'behavioral',
          'architecture',
          'troubleshooting',
          'mcq',
          'case_study',
          'open_ended',
          'follow_up'
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'chk_job_positions_question_type_default'
  ) then
    alter table public.job_positions
      add constraint chk_job_positions_question_type_default
      check (
        question_type_default in (
          'AUTO',
          'coding',
          'technical_discussion',
          'system_design',
          'behavioral',
          'architecture',
          'troubleshooting',
          'mcq',
          'case_study'
        )
      );
  end if;
end $$;

update public.interview_questions
set
  question_type = case
    when lower(coalesce(question_type, '')) in ('behavioral') then 'behavioral'
    when question_text ~* '\b(write|implement|create|build)\s+(a|an|the)?\s*(function|method|class|api|component|program|script|query|stored procedure|table)\b'
      or question_text ~* '\b(coding challenge|solve .*algorithm|submit code|return executable|debug (this|the)?\s*(code|function|program|query))\b'
      then 'coding'
    when question_text ~* '\b(system design|design (a|an|the)?\s*(scalable|distributed|high availability|payment|chat|feed|system|platform|service)|how would you build|distributed system|high availability|disaster recovery|ha/dr)\b'
      then 'system_design'
    when question_text ~* '\b(production outage|incident|root cause|rca|deadlock|memory leak|high cpu|replication lag|api failure|what would you check|troubleshoot)\b'
      then 'troubleshooting'
    when question_text ~* '\b(tell me about a time|conflict|leadership|teamwork|pressure|failure|ownership|communication)\b'
      then 'behavioral'
    when question_text ~* '\b(case study|scenario|client escalation|migration scenario|trade[- ]?off analysis)\b'
      then 'case_study'
    when question_text ~* '\b(enterprise architecture|platform modernization|cloud strategy|security architecture|governance|roadmap)\b'
      then 'architecture'
    else 'technical_discussion'
  end,
  classifier_confidence = coalesce(classifier_confidence, 0.70),
  rendering_mode = case
    when question_text ~* '\b(write|implement|create|build)\s+(a|an|the)?\s*(function|method|class|api|component|program|script|query|stored procedure|table)\b'
      or question_text ~* '\b(coding challenge|solve .*algorithm|submit code|return executable|debug (this|the)?\s*(code|function|program|query))\b'
      then 'code_editor'
    when question_text ~* '\b(system design|design (a|an|the)?\s*(scalable|distributed|high availability|payment|chat|feed|system|platform|service)|how would you build|distributed system|high availability|disaster recovery|ha/dr)\b'
      then 'system_design'
    when question_text ~* '\b(production outage|incident|root cause|rca|deadlock|memory leak|high cpu|replication lag|api failure|what would you check|troubleshoot)\b'
      then 'troubleshooting'
    when question_text ~* '\b(tell me about a time|conflict|leadership|teamwork|pressure|failure|ownership|communication)\b'
      then 'behavioral'
    when question_text ~* '\b(case study|scenario|client escalation|migration scenario|trade[- ]?off analysis)\b'
      then 'case_study'
    when question_text ~* '\b(enterprise architecture|platform modernization|cloud strategy|security architecture|governance|roadmap)\b'
      then 'architecture'
    else 'discussion'
  end
where question_type is null or question_type in ('open_ended', 'technical');
