alter table interviews
  add column if not exists required_follow_up_questions integer not null default 2;

update interviews
set required_follow_up_questions = least(coalesce(question_count, 2), 2);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_interviews_required_follow_up_questions_non_negative'
  ) then
    alter table interviews
      add constraint chk_interviews_required_follow_up_questions_non_negative
      check (required_follow_up_questions >= 0);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_interviews_follow_up_question_budget'
  ) then
    alter table interviews
      add constraint chk_interviews_follow_up_question_budget
      check (question_count is null or required_follow_up_questions <= question_count);
  end if;
end $$;

alter table interview_questions
  add column if not exists allow_follow_up boolean not null default true;

alter table session_questions
  add column if not exists parent_session_question_id uuid,
  add column if not exists question_kind text,
  add column if not exists question_order integer;

update session_questions
set question_kind = coalesce(question_kind, 'core')
where question_kind is null;

with ranked as (
  select
    session_question_id,
    row_number() over (
      partition by attempt_id
      order by asked_at asc nulls last, session_question_id asc
    ) as seq
  from session_questions
)
update session_questions sq
set question_order = ranked.seq
from ranked
where ranked.session_question_id = sq.session_question_id
  and sq.question_order is null;

alter table session_questions
  alter column question_kind set default 'core',
  alter column question_kind set not null,
  alter column question_order set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_session_questions_question_kind'
  ) then
    alter table session_questions
      add constraint chk_session_questions_question_kind
      check (question_kind in ('core', 'follow_up'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'fk_session_questions_parent'
  ) then
    alter table session_questions
      add constraint fk_session_questions_parent
      foreign key (parent_session_question_id)
      references session_questions(session_question_id)
      on delete set null;
  end if;
end $$;

create index if not exists idx_session_questions_attempt_order
  on session_questions (attempt_id, question_order);

create index if not exists idx_session_questions_parent
  on session_questions (parent_session_question_id);

create unique index if not exists uq_interview_answers_session_question
  on interview_answers (session_question_id)
  where session_question_id is not null;

create or replace function public.build_follow_up_question(
  p_last_answer text,
  p_last_question text,
  p_skill_name text,
  p_probe_type text,
  p_is_contradiction boolean
)
returns text
language plpgsql
as $$
declare
  v_answer text := nullif(trim(coalesce(p_last_answer, '')), '');
  v_clean_answer text;
  v_role text;
  v_experience text;
  v_primary_skill text := nullif(trim(coalesce(p_skill_name, '')), '');
  v_primary_tool text := null;
begin
  if v_answer is null then
    return 'Can you give one concrete example from your recent work and explain the result?';
  end if;

  v_clean_answer := regexp_replace(v_answer, '\s+', ' ', 'g');
  v_clean_answer := regexp_replace(v_clean_answer, '^(hi|hello|hey)\m[\s,.-]*', '', 'i');
  v_clean_answer := regexp_replace(v_clean_answer, '^(so|well|okay|alright|basically|actually)\m[\s,.-]*', '', 'i');
  v_clean_answer := regexp_replace(
    v_clean_answer,
    '\m(my name is|i am|i''m|this is)\M\s+[a-z][a-z\s.''-]{1,40}(?:\s*,\s*|\s+and\s+)',
    '',
    'i'
  );
  v_clean_answer := regexp_replace(
    v_clean_answer,
    '\m(you know|kind of|sort of|basically|actually|like)\M[\s,]*',
    ' ',
    'gi'
  );
  v_clean_answer := trim(regexp_replace(v_clean_answer, '\s+', ' ', 'g'));

  v_role := substring(
    v_clean_answer
    from '(?:i work(?:ing)? as|currently work(?:ing)? as|working as|my role is|i serve as|i''m|i am)\s+(?:an?\s+)?([^,.;]+?)(?:\s+(?:with|where|focused|handling|responsible|using|on)\M|[,.;]|$)'
  );

  if v_role is null then
    v_role := substring(
      v_clean_answer
      from '(?:current role(?: is)?|position(?: is)?)\s+(?:an?\s+)?([^,.;]+?)(?:\s+(?:with|where|focused|handling|responsible|using|on)\M|[,.;]|$)'
    );
  end if;

  if v_role is not null then
    v_role := trim(regexp_replace(v_role, '^(an?|the)\s+', '', 'i'));
    v_role := trim(regexp_replace(v_role, '\m(?:at|with|for)\M.*$', '', 'i'));
    v_role := trim(regexp_replace(v_role, '[.,"'']', '', 'g'));

    if v_role !~* '\m(admin|administrator|engineer|developer|analyst|manager|lead|architect|consultant|specialist|officer)\M' then
      v_role := null;
    end if;
  end if;

  v_experience := substring(
    v_clean_answer
    from '\m(\d+\+?\s+(?:years?|yrs?)(?:\s+of)?\s+(?:experience|in [a-z][a-z\s/-]+)?)\M'
  );

  if v_primary_skill is null then
    if v_clean_answer ~* '\mdatabase administration\M' then
      v_primary_skill := 'database administration';
    elsif v_clean_answer ~* '\mdatabase management\M' then
      v_primary_skill := 'database management';
    elsif v_clean_answer ~* '\mperformance tuning\M' then
      v_primary_skill := 'performance tuning';
    elsif v_clean_answer ~* '\mquery optimization\M' then
      v_primary_skill := 'query optimization';
    elsif v_clean_answer ~* '\mbackup and recovery\M' then
      v_primary_skill := 'backup and recovery';
    elsif v_clean_answer ~* '\mincident management\M' then
      v_primary_skill := 'incident management';
    elsif v_clean_answer ~* '\msystem design\M' then
      v_primary_skill := 'system design';
    elsif v_clean_answer ~* '\mapi development\M' then
      v_primary_skill := 'api development';
    elsif v_clean_answer ~* '\mdata migration\M' then
      v_primary_skill := 'data migration';
    elsif v_clean_answer ~* '\metl\M' then
      v_primary_skill := 'ETL';
    elsif v_clean_answer ~* '\msql\M' then
      v_primary_skill := 'SQL';
    elsif v_clean_answer ~* '\mtypescript\M' then
      v_primary_skill := 'TypeScript';
    elsif v_clean_answer ~* '\mnode\.?js\M' then
      v_primary_skill := 'Node.js';
    elsif v_clean_answer ~* '\mreact\M' then
      v_primary_skill := 'React';
    elsif v_clean_answer ~* '\mpython\M' then
      v_primary_skill := 'Python';
    end if;
  end if;

  if v_clean_answer ~* '\moracle\M' then
    v_primary_tool := 'Oracle';
  elsif v_clean_answer ~* '\mpostgresql\M|\mpostgres\M' then
    v_primary_tool := 'PostgreSQL';
  elsif v_clean_answer ~* '\mmysql\M' then
    v_primary_tool := 'MySQL';
  elsif v_clean_answer ~* '\mmongodb\M' then
    v_primary_tool := 'MongoDB';
  elsif v_clean_answer ~* '\msql server\M' then
    v_primary_tool := 'SQL Server';
  elsif v_clean_answer ~* '\mlinux\M' then
    v_primary_tool := 'Linux';
  elsif v_clean_answer ~* '\maws\M' then
    v_primary_tool := 'AWS';
  elsif v_clean_answer ~* '\mazure\M' then
    v_primary_tool := 'Azure';
  elsif v_clean_answer ~* '\mdocker\M' then
    v_primary_tool := 'Docker';
  elsif v_clean_answer ~* '\mkubernetes\M' then
    v_primary_tool := 'Kubernetes';
  elsif v_clean_answer ~* '\mjira\M' then
    v_primary_tool := 'Jira';
  end if;

  if coalesce(p_is_contradiction, false) then
    return 'Can you clarify the specific steps you took, the decisions you made, and how you verified the outcome?';
  end if;

  if coalesce(p_probe_type, '') = 'numbers' then
    return 'What was the measurable outcome of that work, and how did you track it?';
  end if;

  if coalesce(p_probe_type, '') = 'tools' and coalesce(v_primary_tool, v_primary_skill) is not null then
    return format(
      'How have you used %s in a recent project, and what was the result?',
      coalesce(v_primary_tool, v_primary_skill)
    );
  end if;

  if v_role is not null and coalesce(v_primary_skill, v_primary_tool) is not null then
    return format(
      'In your role as a %s, can you walk me through a recent project where you applied %s?',
      v_role,
      coalesce(v_primary_skill, v_primary_tool)
    );
  end if;

  if v_role is not null then
    return format(
      'In your role as a %s, can you walk me through a recent project and the outcome?',
      v_role
    );
  end if;

  if coalesce(v_primary_skill, v_primary_tool) is not null then
    return format(
      'Can you walk me through a recent project where you used %s and the result you achieved?',
      coalesce(v_primary_skill, v_primary_tool)
    );
  end if;

  if v_experience is not null then
    return format(
      'From your %s, can you share one concrete example of a problem you solved and the result?',
      v_experience
    );
  end if;

  return 'Can you walk me through one recent project, your responsibilities, and the outcome?';
end;
$$;

create or replace function public.build_follow_up_question(p_last_answer text)
returns text
language sql
as $$
  select public.build_follow_up_question($1, null, null, null, false);
$$;

create or replace function public.start_interview_session(p_token text)
returns table (
  attempt_id uuid,
  interview_id uuid,
  attempt_number integer,
  reused boolean
)
language plpgsql
as $$
declare
  v_invite interview_invites%rowtype;
  v_latest_attempt interview_attempts%rowtype;
  v_now timestamptz := now();
  v_attempts_used integer;
  v_max_attempts integer;
begin
  if nullif(trim(coalesce(p_token, '')), '') is null then
    raise exception 'token is required';
  end if;

  select *
  into v_invite
  from interview_invites
  where token = trim(p_token)
  for update;

  if not found then
    raise exception 'Invite not found';
  end if;

  if v_invite.status is not null and v_invite.status <> 'ACTIVE' then
    raise exception 'Invite is not active';
  end if;

  if v_invite.expires_at is not null and v_invite.expires_at <= v_now then
    raise exception 'Invite has expired';
  end if;

  select *
  into v_latest_attempt
  from interview_attempts
  where interview_id = v_invite.interview_id
  order by attempt_number desc, started_at desc
  limit 1;

  if found and lower(coalesce(v_latest_attempt.status, '')) = 'started' then
    return query
    select
      v_latest_attempt.attempt_id,
      v_latest_attempt.interview_id,
      v_latest_attempt.attempt_number,
      true;
    return;
  end if;

  v_attempts_used := coalesce(v_invite.attempts_used, 0);
  v_max_attempts := coalesce(v_invite.max_attempts, 1);

  if v_attempts_used >= v_max_attempts then
    raise exception 'Maximum attempts reached for this invite';
  end if;

  insert into interview_attempts (
    interview_id,
    attempt_number,
    status
  )
  values (
    v_invite.interview_id,
    coalesce(v_latest_attempt.attempt_number, 0) + 1,
    'started'
  )
  returning
    interview_attempts.attempt_id,
    interview_attempts.interview_id,
    interview_attempts.attempt_number
  into attempt_id, interview_id, attempt_number;

  update interview_invites
  set
    attempts_used = coalesce(attempts_used, 0) + 1,
    used_at = v_now
  where invite_id = v_invite.invite_id;

  reused := false;
  return next;
end;
$$;

create or replace function public.get_first_interview_question(p_attempt_id uuid)
returns table (
  session_question_id uuid,
  question_id uuid,
  content text,
  source text,
  question_kind text,
  question_order integer,
  asked_at timestamptz
)
language plpgsql
as $$
declare
  v_interview_id uuid;
  v_first_question questions%rowtype;
  v_next_order integer;
begin
  if p_attempt_id is null then
    raise exception 'attempt_id is required';
  end if;

  select sq.session_question_id, sq.question_id, sq.content, sq.source, sq.question_kind, sq.question_order, sq.asked_at
  into session_question_id, question_id, content, source, question_kind, question_order, asked_at
  from session_questions sq
  where sq.attempt_id = p_attempt_id
  order by sq.question_order asc, sq.asked_at asc nulls last
  limit 1;

  if found then
    return next;
    return;
  end if;

  select ia.interview_id
  into v_interview_id
  from interview_attempts ia
  where ia.attempt_id = p_attempt_id;

  if v_interview_id is null then
    raise exception 'Interview attempt not found';
  end if;

  select q.*
  into v_first_question
  from interview_questions iq
  join questions q on q.question_id = iq.question_id
  where iq.interview_id = v_interview_id
    and q.is_active = true
  order by iq.question_order asc
  limit 1;

  v_next_order := 1;

  insert into session_questions (
    attempt_id,
    question_id,
    content,
    source,
    question_kind,
    question_order
  )
  values (
    p_attempt_id,
    v_first_question.question_id,
    coalesce(v_first_question.question_text, 'Tell me about your experience and the work most relevant to this role.'),
    'system',
    'core',
    v_next_order
  )
  returning
    session_questions.session_question_id,
    session_questions.question_id,
    session_questions.content,
    session_questions.source,
    session_questions.question_kind,
    session_questions.question_order,
    session_questions.asked_at
  into session_question_id, question_id, content, source, question_kind, question_order, asked_at;

  return next;
end;
$$;

create or replace function public.submit_interview_answer(
  p_session_question_id uuid,
  p_transcript text,
  p_duration_seconds integer default null
)
returns table (
  answer_id uuid,
  attempt_id uuid,
  question_id uuid,
  session_question_id uuid,
  answer_text text,
  answer_payload jsonb,
  answered_at timestamptz
)
language plpgsql
as $$
declare
  v_session_question session_questions%rowtype;
  v_payload jsonb;
begin
  if p_session_question_id is null then
    raise exception 'session_question_id is required';
  end if;

  if nullif(trim(coalesce(p_transcript, '')), '') is null then
    raise exception 'transcript is required';
  end if;

  select *
  into v_session_question
  from session_questions
  where session_question_id = p_session_question_id;

  if not found then
    raise exception 'Session question not found';
  end if;

  v_payload := case
    when p_duration_seconds is null then null
    else jsonb_build_object('duration', p_duration_seconds)
  end;

  update interview_answers
  set
    answer_text = trim(p_transcript),
    answer_payload = v_payload,
    answered_at = now()
  where interview_answers.session_question_id = p_session_question_id
  returning
    interview_answers.answer_id,
    interview_answers.attempt_id,
    interview_answers.question_id,
    interview_answers.session_question_id,
    interview_answers.answer_text,
    interview_answers.answer_payload,
    interview_answers.answered_at
  into answer_id, attempt_id, question_id, session_question_id, answer_text, answer_payload, answered_at;

  if found then
    return next;
    return;
  end if;

  insert into interview_answers (
    attempt_id,
    question_id,
    session_question_id,
    answer_text,
    answer_payload
  )
  values (
    v_session_question.attempt_id,
    v_session_question.question_id,
    v_session_question.session_question_id,
    trim(p_transcript),
    v_payload
  )
  returning
    interview_answers.answer_id,
    interview_answers.attempt_id,
    interview_answers.question_id,
    interview_answers.session_question_id,
    interview_answers.answer_text,
    interview_answers.answer_payload,
    interview_answers.answered_at
  into answer_id, attempt_id, question_id, session_question_id, answer_text, answer_payload, answered_at;

  return next;
end;
$$;

create or replace function public.get_next_interview_question(
  p_attempt_id uuid,
  p_last_answer text default null
)
returns table (
  session_question_id uuid,
  question_id uuid,
  content text,
  source text,
  question_kind text,
  question_order integer,
  asked_at timestamptz,
  is_complete boolean
)
language plpgsql
as $$
declare
  v_attempt interview_attempts%rowtype;
  v_interview interviews%rowtype;
  v_latest_question session_questions%rowtype;
  v_latest_answer_text text;
  v_latest_answer_duration integer;
  v_next_core_question_id uuid;
  v_next_core_content text;
  v_latest_allow_follow_up boolean := true;
  v_asked_total integer;
  v_asked_follow_ups integer;
  v_remaining_follow_ups integer;
  v_remaining_slots integer;
  v_word_count integer := 0;
  v_should_ask_follow_up boolean := false;
  v_next_order integer;
begin
  if p_attempt_id is null then
    raise exception 'attempt_id is required';
  end if;

  select *
  into v_attempt
  from interview_attempts
  where attempt_id = p_attempt_id;

  if not found then
    raise exception 'Interview attempt not found';
  end if;

  select *
  into v_interview
  from interviews
  where interview_id = v_attempt.interview_id;

  if not found then
    raise exception 'Interview not found';
  end if;

  select count(*)
  into v_asked_total
  from session_questions
  where attempt_id = p_attempt_id;

  select count(*)
  into v_asked_follow_ups
  from session_questions
  where attempt_id = p_attempt_id
    and question_kind = 'follow_up';

  v_remaining_slots := greatest(coalesce(v_interview.question_count, 9) - v_asked_total, 0);
  v_remaining_follow_ups := greatest(coalesce(v_interview.required_follow_up_questions, 2) - v_asked_follow_ups, 0);

  if v_remaining_slots <= 0 then
    is_complete := true;
    return next;
    return;
  end if;

  select *
  into v_latest_question
  from session_questions
  where attempt_id = p_attempt_id
  order by question_order desc, asked_at desc nulls last
  limit 1;

  if v_latest_question.session_question_id is not null then
    select ia.answer_text,
           nullif((ia.answer_payload ->> 'duration')::integer, 0)
    into v_latest_answer_text, v_latest_answer_duration
    from interview_answers ia
    where ia.session_question_id = v_latest_question.session_question_id
    order by ia.answered_at desc nulls last
    limit 1;

    if v_latest_question.question_id is not null then
      select iq.allow_follow_up
      into v_latest_allow_follow_up
      from interview_questions iq
      where iq.interview_id = v_attempt.interview_id
        and iq.question_id = v_latest_question.question_id
      limit 1;
    end if;
  end if;

  v_latest_answer_text := coalesce(nullif(trim(coalesce(p_last_answer, '')), ''), v_latest_answer_text);

  if nullif(trim(coalesce(v_latest_answer_text, '')), '') is not null then
    v_word_count := array_length(regexp_split_to_array(trim(v_latest_answer_text), '\s+'), 1);
  end if;

  select
    q.question_id,
    q.question_text
  into
    v_next_core_question_id,
    v_next_core_content
  from interview_questions iq
  join questions q on q.question_id = iq.question_id
  where iq.interview_id = v_attempt.interview_id
    and q.is_active = true
    and not exists (
      select 1
      from session_questions sq
      where sq.attempt_id = p_attempt_id
        and sq.question_kind = 'core'
        and sq.question_id = iq.question_id
    )
  order by iq.question_order asc
  limit 1;

  v_should_ask_follow_up :=
    v_latest_question.session_question_id is not null
    and v_latest_question.question_kind = 'core'
    and coalesce(v_latest_allow_follow_up, true)
    and v_remaining_follow_ups > 0
    and nullif(trim(coalesce(v_latest_answer_text, '')), '') is not null
    and (
      v_word_count >= 25
      or coalesce(v_latest_answer_duration, 0) >= 45
      or v_remaining_slots <= (v_remaining_follow_ups + 1)
      or v_next_core_question_id is null
    );

  select coalesce(max(question_order), 0) + 1
  into v_next_order
  from session_questions
  where attempt_id = p_attempt_id;

  if v_should_ask_follow_up then
    insert into session_questions (
      attempt_id,
      question_id,
      parent_session_question_id,
      content,
      source,
      question_kind,
      question_order
    )
    values (
      p_attempt_id,
      null,
      v_latest_question.session_question_id,
      public.build_follow_up_question(v_latest_answer_text),
      'ai',
      'follow_up',
      v_next_order
    )
    returning
      session_questions.session_question_id,
      session_questions.question_id,
      session_questions.content,
      session_questions.source,
      session_questions.question_kind,
      session_questions.question_order,
      session_questions.asked_at
    into session_question_id, question_id, content, source, question_kind, question_order, asked_at;

    is_complete := false;
    return next;
    return;
  end if;

  if v_next_core_question_id is not null then
    insert into session_questions (
      attempt_id,
      question_id,
      content,
      source,
      question_kind,
      question_order
    )
    values (
      p_attempt_id,
      v_next_core_question_id,
      v_next_core_content,
      'system',
      'core',
      v_next_order
    )
    returning
      session_questions.session_question_id,
      session_questions.question_id,
      session_questions.content,
      session_questions.source,
      session_questions.question_kind,
      session_questions.question_order,
      session_questions.asked_at
    into session_question_id, question_id, content, source, question_kind, question_order, asked_at;

    is_complete := false;
    return next;
    return;
  end if;

  if v_remaining_follow_ups > 0 and nullif(trim(coalesce(v_latest_answer_text, '')), '') is not null then
    insert into session_questions (
      attempt_id,
      question_id,
      parent_session_question_id,
      content,
      source,
      question_kind,
      question_order
    )
    values (
      p_attempt_id,
      null,
      v_latest_question.session_question_id,
      public.build_follow_up_question(v_latest_answer_text),
      'ai',
      'follow_up',
      v_next_order
    )
    returning
      session_questions.session_question_id,
      session_questions.question_id,
      session_questions.content,
      session_questions.source,
      session_questions.question_kind,
      session_questions.question_order,
      session_questions.asked_at
    into session_question_id, question_id, content, source, question_kind, question_order, asked_at;

    is_complete := false;
    return next;
    return;
  end if;

  is_complete := true;
  return next;
end;
$$;
