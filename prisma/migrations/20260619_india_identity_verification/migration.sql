-- HireVeri India-only, optional pre-interview identity verification.
-- Safe to re-run in Supabase SQL editor.

create extension if not exists pgcrypto;

alter table public.candidates
  add column if not exists country text,
  add column if not exists date_of_birth date,
  add column if not exists gender text;

alter table public.job_positions
  add column if not exists location_country text;

create table if not exists public.candidate_identity_verifications (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidates(candidate_id) on delete cascade,
  interview_id uuid not null references public.interviews(interview_id) on delete cascade,
  attempt_id uuid references public.interview_attempts(attempt_id) on delete set null,
  country text not null default 'India',
  verification_status text not null default 'pending',
  verification_method text not null default 'none',
  verification_provider text not null default 'manual_upload',
  digilocker_connected boolean not null default false,
  aadhaar_last4 text,
  full_name text,
  dob date,
  gender text,
  document_urls jsonb not null default '[]'::jsonb,
  ocr_data jsonb not null default '{}'::jsonb,
  encrypted_ocr_data bytea,
  trust_score integer not null default 0,
  name_match boolean,
  dob_match boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint candidate_identity_verifications_status_check
    check (verification_status in ('pending', 'verified', 'partial', 'skipped', 'failed')),
  constraint candidate_identity_verifications_method_check
    check (verification_method in ('digilocker', 'aadhaar_scan', 'manual_upload', 'none')),
  constraint candidate_identity_verifications_provider_check
    check (verification_provider in ('digilocker', 'aadhaar_otp', 'manual_upload', 'passport_scan')),
  constraint candidate_identity_verifications_score_check
    check (trust_score between 0 and 100),
  constraint candidate_identity_verifications_aadhaar_check
    check (aadhaar_last4 is null or aadhaar_last4 ~ '^[0-9]{4}$')
);

create unique index if not exists uq_identity_verification_attempt
  on public.candidate_identity_verifications(attempt_id)
  where attempt_id is not null;

create index if not exists idx_identity_verification_candidate
  on public.candidate_identity_verifications(candidate_id, created_at desc);

create index if not exists idx_identity_verification_interview
  on public.candidate_identity_verifications(interview_id, created_at desc);

create table if not exists public.verification_audit_logs (
  id uuid primary key default gen_random_uuid(),
  verification_id uuid references public.candidate_identity_verifications(id) on delete set null,
  candidate_id uuid not null references public.candidates(candidate_id) on delete cascade,
  interview_id uuid references public.interviews(interview_id) on delete set null,
  attempt_id uuid references public.interview_attempts(attempt_id) on delete set null,
  action text not null,
  ip inet,
  actor_id uuid,
  actor_role text not null default 'candidate',
  metadata jsonb not null default '{}'::jsonb,
  "timestamp" timestamptz not null default now()
);

create index if not exists idx_verification_audit_candidate_time
  on public.verification_audit_logs(candidate_id, "timestamp" desc);

create or replace function public.identity_verification_trust_score(
  p_document_urls jsonb,
  p_name_match boolean,
  p_dob_match boolean,
  p_digilocker_connected boolean
) returns integer
language sql
immutable
as $$
  select least(
    100,
    (case when exists (
      select 1 from jsonb_array_elements(coalesce(p_document_urls, '[]'::jsonb)) d
      where d->>'type' in ('aadhaar', 'pan', 'passport')
    ) then 30 else 0 end) +
    (case when p_name_match is true then 20 else 0 end) +
    (case when p_dob_match is true then 15 else 0 end) +
    (case when exists (
      select 1 from jsonb_array_elements(coalesce(p_document_urls, '[]'::jsonb)) d
      where d->>'type' = 'degree'
    ) then 15 else 0 end) +
    (case when exists (
      select 1 from jsonb_array_elements(coalesce(p_document_urls, '[]'::jsonb)) d
      where d->>'type' = 'experience'
    ) then 10 else 0 end) +
    (case when p_digilocker_connected is true then 10 else 0 end)
  );
$$;

create or replace function public.refresh_identity_verification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  new.trust_score := public.identity_verification_trust_score(
    new.document_urls,
    new.name_match,
    new.dob_match,
    new.digilocker_connected
  );

  if new.verification_status not in ('skipped', 'failed') then
    if new.trust_score >= 71 then
      new.verification_status := 'verified';
    elsif new.trust_score > 0 then
      new.verification_status := 'partial';
    else
      new.verification_status := 'pending';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_refresh_identity_verification
  on public.candidate_identity_verifications;
create trigger trg_refresh_identity_verification
before insert or update of document_urls, name_match, dob_match, digilocker_connected,
  verification_status
on public.candidate_identity_verifications
for each row execute function public.refresh_identity_verification();

-- Full raw OCR payload encryption. The application sets app.identity_ocr_key for
-- the transaction before calling this function. Only redacted OCR belongs in ocr_data.
create or replace function public.set_identity_verification_ocr(
  p_verification_id uuid,
  p_candidate_id uuid,
  p_redacted_ocr jsonb,
  p_raw_ocr jsonb,
  p_full_name text,
  p_dob date,
  p_gender text,
  p_aadhaar_last4 text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  encryption_key text := current_setting('app.identity_ocr_key', true);
begin
  if encryption_key is null or length(encryption_key) < 32 then
    raise exception 'app.identity_ocr_key must be configured';
  end if;

  update public.candidate_identity_verifications
  set ocr_data = coalesce(p_redacted_ocr, '{}'::jsonb),
      encrypted_ocr_data = pgp_sym_encrypt(
        coalesce(p_raw_ocr, '{}'::jsonb)::text,
        encryption_key,
        'cipher-algo=aes256, compress-algo=1'
      ),
      full_name = nullif(trim(p_full_name), ''),
      dob = p_dob,
      gender = nullif(trim(p_gender), ''),
      aadhaar_last4 = case
        when p_aadhaar_last4 ~ '^[0-9]{4}$' then p_aadhaar_last4
        else null
      end
  where id = p_verification_id
    and candidate_id = p_candidate_id;
end;
$$;

-- Link the optional verification created before precheck to the attempt created
-- by the existing session-start transaction.
create or replace function public.link_identity_verification_attempt(
  p_interview_id uuid,
  p_candidate_id uuid,
  p_attempt_id uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_verification_id uuid;
begin
  select id into v_verification_id
  from public.candidate_identity_verifications
  where interview_id = p_interview_id
    and candidate_id = p_candidate_id
    and attempt_id is null
  order by created_at desc
  limit 1
  for update;

  if v_verification_id is not null then
    update public.candidate_identity_verifications
    set attempt_id = p_attempt_id
    where id = v_verification_id;

    update public.verification_audit_logs
    set attempt_id = p_attempt_id
    where verification_id = v_verification_id
      and attempt_id is null;
  end if;

  return v_verification_id;
end;
$$;

alter table public.candidate_identity_verifications enable row level security;
alter table public.verification_audit_logs enable row level security;

-- Authenticated candidate access for installations where candidates use Supabase
-- Auth. The HireVeri invite-token flow still uploads through the validated server route.
drop policy if exists candidate_read_own_identity_verification
  on public.candidate_identity_verifications;
create policy candidate_read_own_identity_verification
on public.candidate_identity_verifications for select
to authenticated
using (
  candidate_id in (
    select c.candidate_id
    from public.candidates c
    join public.users u
      on lower(u.email) = lower(c.email)
     and u.organization_id = c.organization_id
    where u.user_id = auth.uid()
  )
);

drop policy if exists candidate_update_own_identity_verification
  on public.candidate_identity_verifications;
create policy candidate_update_own_identity_verification
on public.candidate_identity_verifications for update
to authenticated
using (
  candidate_id in (
    select c.candidate_id
    from public.candidates c
    join public.users u
      on lower(u.email) = lower(c.email)
     and u.organization_id = c.organization_id
    where u.user_id = auth.uid()
  )
)
with check (
  candidate_id in (
    select c.candidate_id
    from public.candidates c
    join public.users u
      on lower(u.email) = lower(c.email)
     and u.organization_id = c.organization_id
    where u.user_id = auth.uid()
  )
);

-- Recruiter/admin table access. Application endpoints must still enforce the
-- interview's organization membership before returning any document.
drop policy if exists recruiter_view_interview_identity_verification
  on public.candidate_identity_verifications;
create policy recruiter_view_interview_identity_verification
on public.candidate_identity_verifications for select
to authenticated
using (
  exists (
    select 1
    from public.interviews i
    join public.users u on u.organization_id = i.organization_id
    where i.interview_id = candidate_identity_verifications.interview_id
      and u.user_id = auth.uid()
      and lower(u.role) in ('recruiter', 'admin', 'super_admin')
  )
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'candidate-verification',
  'candidate-verification',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Object names are candidate_id/verification_id/document-name.ext. No public
-- read policy is created. Recruiter/admin downloads are short-lived signed URLs.
drop policy if exists candidate_upload_own_verification_documents
  on storage.objects;
create policy candidate_upload_own_verification_documents
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'candidate-verification'
  and (storage.foldername(name))[1] in (
    select c.candidate_id::text
    from public.candidates c
    join public.users u
      on lower(u.email) = lower(c.email)
     and u.organization_id = c.organization_id
    where u.user_id = auth.uid()
  )
);

drop policy if exists candidate_read_own_verification_documents
  on storage.objects;
create policy candidate_read_own_verification_documents
on storage.objects for select
to authenticated
using (
  bucket_id = 'candidate-verification'
  and (storage.foldername(name))[1] in (
    select c.candidate_id::text
    from public.candidates c
    join public.users u
      on lower(u.email) = lower(c.email)
     and u.organization_id = c.organization_id
    where u.user_id = auth.uid()
  )
);

revoke all on public.candidate_identity_verifications from anon;
revoke all on public.verification_audit_logs from anon;
grant select, update on public.candidate_identity_verifications to authenticated;
