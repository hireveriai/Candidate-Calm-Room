import { prisma } from "@/app/lib/prisma";
import type {
  IdentityVerificationSummary,
  StoredVerificationDocument,
  VerificationDocumentType,
  VerificationMethod,
  VerificationProvider,
} from "./types";

type ContextRow = {
  interview_id: string;
  candidate_id: string;
  candidate_name: string;
  candidate_country: string | null;
  job_country: string | null;
  device_requirement: "DESKTOP_ONLY" | "MOBILE_ONLY" | "ANY_DEVICE" | null;
  profile_dob: Date | string | null;
};

type VerificationRow = {
  id: string;
  verification_status: IdentityVerificationSummary["status"];
  verification_method: VerificationMethod;
  verification_provider: VerificationProvider;
  trust_score: number;
  digilocker_connected: boolean;
  aadhaar_last4: string | null;
  full_name: string | null;
  dob: Date | string | null;
  gender: string | null;
  document_urls: unknown;
  ocr_data: unknown;
  name_match: boolean | null;
  dob_match: boolean | null;
};

export function normalizeCountry(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (["india", "in", "ind", "भारत"].includes(normalized)) return "India";
  return value!.trim();
}

export function getRequestIp(headers: Headers) {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip") ||
    null
  );
}

export async function resolveInviteContext(token: string) {
  const rows = await prisma.$queryRaw<ContextRow[]>`
    select
      i.interview_id::text,
      i.candidate_id::text,
      c.full_name as candidate_name,
      c.country as candidate_country,
      jp.location_country as job_country,
      coalesce(jp.device_requirement, 'ANY_DEVICE') as device_requirement,
      c.date_of_birth as profile_dob
    from public.interview_invites ii
    join public.interviews i on i.interview_id = ii.interview_id
    join public.candidates c on c.candidate_id = i.candidate_id
    join public.job_positions jp on jp.job_id = i.job_id
    where ii.token = ${token}::text
      and coalesce(ii.status, 'ACTIVE') = 'ACTIVE'
      and (ii.expires_at is null or ii.expires_at > now())
    limit 1
  `;

  return rows[0] ?? null;
}

function asDocuments(value: unknown): StoredVerificationDocument[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is StoredVerificationDocument =>
      Boolean(
        item &&
          typeof item === "object" &&
          "type" in item &&
          "path" in item &&
          "name" in item
      )
  );
}

export function mapVerification(row: VerificationRow): IdentityVerificationSummary {
  return {
    id: row.id,
    status: row.verification_status,
    method: row.verification_method,
    provider: row.verification_provider,
    trustScore: row.trust_score,
    digilockerConnected: row.digilocker_connected,
    aadhaarLast4: row.aadhaar_last4,
    fullName: row.full_name,
    dob: row.dob ? new Date(row.dob).toISOString().slice(0, 10) : null,
    gender: row.gender,
    documents: asDocuments(row.document_urls),
    ocrData:
      row.ocr_data && typeof row.ocr_data === "object"
        ? (row.ocr_data as Record<string, unknown>)
        : {},
    nameMatch: row.name_match,
    dobMatch: row.dob_match,
  };
}

export async function getLatestVerification(interviewId: string) {
  const rows = await prisma.$queryRaw<VerificationRow[]>`
    select
      id::text,
      verification_status,
      verification_method,
      verification_provider,
      trust_score,
      digilocker_connected,
      aadhaar_last4,
      full_name,
      dob,
      gender,
      document_urls,
      ocr_data,
      name_match,
      dob_match
    from public.candidate_identity_verifications
    where interview_id = ${interviewId}::uuid
    order by created_at desc
    limit 1
  `;
  return rows[0] ? mapVerification(rows[0]) : null;
}

export async function ensureVerification(input: {
  candidateId: string;
  interviewId: string;
  country: string;
  method: VerificationMethod;
  provider: VerificationProvider;
}) {
  const rows = await prisma.$queryRaw<VerificationRow[]>`
    insert into public.candidate_identity_verifications (
      candidate_id,
      interview_id,
      country,
      verification_method,
      verification_provider
    )
    values (
      ${input.candidateId}::uuid,
      ${input.interviewId}::uuid,
      ${input.country},
      ${input.method},
      ${input.provider}
    )
    returning
      id::text,
      verification_status,
      verification_method,
      verification_provider,
      trust_score,
      digilocker_connected,
      aadhaar_last4,
      full_name,
      dob,
      gender,
      document_urls,
      ocr_data,
      name_match,
      dob_match
  `;
  return mapVerification(rows[0]);
}

export async function auditVerification(input: {
  verificationId?: string | null;
  candidateId: string;
  interviewId: string;
  action: string;
  ip: string | null;
  metadata?: Record<string, unknown>;
}) {
  await prisma.$executeRaw`
    insert into public.verification_audit_logs (
      verification_id,
      candidate_id,
      interview_id,
      action,
      ip,
      metadata
    )
    values (
      ${input.verificationId ?? null}::uuid,
      ${input.candidateId}::uuid,
      ${input.interviewId}::uuid,
      ${input.action},
      ${input.ip}::inet,
      ${JSON.stringify(input.metadata ?? {})}::jsonb
    )
  `;
}

export function documentTypeFromValue(value: string): VerificationDocumentType | null {
  const normalized = value.trim().toLowerCase();
  return ["aadhaar", "pan", "passport", "degree", "experience"].includes(normalized)
    ? (normalized as VerificationDocumentType)
    : null;
}
