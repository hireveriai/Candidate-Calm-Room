import crypto from "crypto";

import { prisma } from "@/app/lib/prisma";
import { assertUuid, getTimerState, logInterviewEvent } from "@/app/lib/interviewReliability";

export const TECHNICAL_INTERRUPTION_CLASSIFIERS = [
  "NETWORK_ISSUE",
  "POWER_ISSUE",
  "DEVICE_FAILURE",
  "BROWSER_CRASH",
  "MEDIA_FAILURE",
  "TRANSCRIPT_STREAM_FAILURE",
  "PROLONGED_SILENCE_TIMEOUT",
  "UNKNOWN",
] as const;

export type InterruptionClassifier =
  (typeof TECHNICAL_INTERRUPTION_CLASSIFIERS)[number];

type RecoveryEventInput = {
  attemptId: string;
  classifier?: string | null;
  reason?: string | null;
  source?: string | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
};

type AttemptRecoveryRow = {
  attempt_id: string;
  interview_id: string;
  attempt_number: number;
  status: string;
  started_at: Date | string | null;
  ends_at: Date | string | null;
  max_attempts: number | null;
  recovery_allowed: boolean | null;
  recovery_used: boolean | null;
  completion_percentage: string | number | null;
  duration_minutes: number | null;
  candidate_id: string | null;
  candidate_name: string | null;
};

type RecoveryStartRow = {
  attempt_id: string;
  interview_id: string;
  attempt_number: number;
  reused: boolean;
  candidate_id: string | null;
  candidate_name: string | null;
  ends_at: Date | string | null;
};

export async function ensureInterviewRecoverySchema() {
  await prisma.$executeRawUnsafe(`
    alter table if exists public.interviews
      add column if not exists recovery_allowed boolean not null default true,
      add column if not exists recovery_used boolean not null default false,
      add column if not exists final_status text,
      add column if not exists forensic_timeline_id uuid,
      alter column max_attempts set default 2
  `);

  await prisma.$executeRawUnsafe(`
    update public.interviews
    set max_attempts = greatest(coalesce(max_attempts, 1), 2)
    where max_attempts is null or max_attempts < 2
  `);

  await prisma.$executeRawUnsafe(`
    alter table if exists public.interview_attempts
      add column if not exists interruption_reason text,
      add column if not exists interruption_detected_at timestamptz,
      add column if not exists transcript_status text not null default 'PENDING',
      add column if not exists recording_status text not null default 'PENDING',
      add column if not exists timer_remaining_seconds integer,
      add column if not exists inherited_from_attempt_id uuid references public.interview_attempts(attempt_id),
      add column if not exists recovery_link_issued_at timestamptz,
      add column if not exists recovery_link_expires_at timestamptz,
      add column if not exists recovery_decision text,
      add column if not exists recovery_decided_by uuid,
      add column if not exists recovery_decided_at timestamptz,
      add column if not exists recovery_token_hash text,
      add column if not exists recovery_token_used_at timestamptz,
      add column if not exists recovery_policy jsonb not null default '{}'::jsonb
  `);

  await prisma.$executeRawUnsafe(`
    create table if not exists public.interview_recovery_events (
      recovery_event_id uuid primary key default gen_random_uuid(),
      interview_id uuid not null references public.interviews(interview_id) on delete cascade,
      attempt_id uuid references public.interview_attempts(attempt_id) on delete set null,
      inherited_from_attempt_id uuid references public.interview_attempts(attempt_id) on delete set null,
      event_type text not null,
      classifier text,
      reason text,
      source text not null default 'system',
      idempotency_key text,
      occurred_at timestamptz not null default now(),
      actor_id uuid,
      metadata jsonb not null default '{}'::jsonb
    )
  `);

  await prisma.$executeRawUnsafe(`
    create unique index if not exists ux_recovery_events_idempotency
      on public.interview_recovery_events(interview_id, idempotency_key)
      where idempotency_key is not null
  `);

  await prisma.$executeRawUnsafe(`
    create unique index if not exists ux_interview_active_recovery_token
      on public.interview_attempts(recovery_token_hash)
      where recovery_token_hash is not null and recovery_token_used_at is null
  `);
}

function normalizeClassifier(value: string | null | undefined): InterruptionClassifier {
  const normalized = String(value ?? "UNKNOWN").trim().toUpperCase();
  return (TECHNICAL_INTERRUPTION_CLASSIFIERS as readonly string[]).includes(normalized)
    ? (normalized as InterruptionClassifier)
    : "UNKNOWN";
}

function asNumber(value: string | number | null | undefined) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function getTokenHash(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function recordInterviewInterruption(input: RecoveryEventInput) {
  await ensureInterviewRecoverySchema();
  const attemptId = assertUuid(input.attemptId, "attemptId");
  const classifier = normalizeClassifier(input.classifier);
  const source = input.source?.trim() || "candidate_calm_room";
  const idempotencyKey =
    input.idempotencyKey?.trim() ||
    `${attemptId}:${classifier}:${input.reason ?? "interruption"}`;

  const rows = await prisma.$queryRaw<AttemptRecoveryRow[]>`
    select
      ia.attempt_id,
      ia.interview_id,
      ia.attempt_number,
      ia.status,
      ia.started_at,
      ia.ends_at,
      i.max_attempts,
      i.recovery_allowed,
      i.recovery_used,
      ia.completion_percentage,
      i.duration_minutes,
      i.candidate_id::text,
      c.full_name as candidate_name
    from public.interview_attempts ia
    join public.interviews i on i.interview_id = ia.interview_id
    left join public.candidates c on c.candidate_id = i.candidate_id
    where ia.attempt_id = ${attemptId}::uuid
    limit 1
  `;

  const attempt = rows[0];
  if (!attempt) {
    throw new Error("Interview attempt not found");
  }

  const timerState = getTimerState({
    startedAt: attempt.started_at,
    endsAt: attempt.ends_at,
  });
  const existingCompletion = asNumber(attempt.completion_percentage);
  const computedCompletion =
    existingCompletion > 1 ? existingCompletion / 100 : existingCompletion;

  await prisma.$transaction(async (tx: typeof prisma) => {
    await tx.$executeRaw`
      update public.interview_attempts
      set interruption_reason = ${input.reason ?? classifier}::text,
          interruption_detected_at = coalesce(interruption_detected_at, now()),
          timer_remaining_seconds = ${timerState.remainingSeconds}::integer,
          completion_percentage = coalesce(completion_percentage, ${computedCompletion}::numeric),
          transcript_status = case
            when ${String(input.metadata?.transcriptBuffer ?? "").trim() !== ""} then 'PARTIAL'
            else transcript_status
          end
      where attempt_id = ${attemptId}::uuid
        and lower(status) <> 'completed'
        and upper(coalesce(status, '')) <> 'FINALIZED'
    `;

    await tx.$executeRaw`
      update public.interviews
      set status = 'INTERRUPTED',
          final_status = 'INTERRUPTED',
          recovery_allowed = coalesce(recovery_allowed, true)
      where interview_id = ${attempt.interview_id}::uuid
        and coalesce(recovery_used, false) = false
    `;

    await tx.$executeRaw`
      insert into public.interview_recovery_events (
        interview_id,
        attempt_id,
        event_type,
        classifier,
        reason,
        source,
        idempotency_key,
        metadata
      )
      values (
        ${attempt.interview_id}::uuid,
        ${attemptId}::uuid,
        'INTERRUPTION_DETECTED',
        ${classifier}::text,
        ${input.reason ?? null}::text,
        ${source}::text,
        ${idempotencyKey}::text,
        ${JSON.stringify({
          ...input.metadata,
          timerState,
          completionPercentage: computedCompletion,
        })}::jsonb
      )
      on conflict (interview_id, idempotency_key)
      where idempotency_key is not null
      do nothing
    `;

    if (String(input.metadata?.transcriptBuffer ?? "").trim()) {
      await tx.$executeRaw`
        insert into public.forensic_transcripts (
          attempt_id,
          segment_index,
          start_ms,
          end_ms,
          transcript,
          confidence,
          cognitive_flag,
          sealed
        )
        values (
          ${attemptId}::uuid,
          coalesce((
            select max(segment_index) + 1
            from public.forensic_transcripts
            where attempt_id = ${attemptId}::uuid
          ), 1),
          0,
          0,
          ${String(input.metadata?.transcriptBuffer)}::text,
          null,
          'RECOVERY_BUFFER',
          false
        )
      `;
    }
  });

  logInterviewEvent("warn", "interview.interrupted", {
    attemptId,
    interviewId: attempt.interview_id,
    timerState,
    classifier,
    reason: input.reason ?? null,
  });

  return {
    interviewId: attempt.interview_id,
    attemptId,
    status: "INTERRUPTED",
    classifier,
    recoveryAvailable:
      Boolean(attempt.recovery_allowed) &&
      !attempt.recovery_used &&
      attempt.attempt_number < Math.max(attempt.max_attempts ?? 2, 1),
    timerRemainingSeconds: timerState.remainingSeconds,
    completionPercentage: Math.round(computedCompletion * 100),
  };
}

export async function startRecoveryAttemptFromToken(token: string) {
  await ensureInterviewRecoverySchema();
  const tokenHash = getTokenHash(token.trim());
  const now = new Date();

  const rows = await prisma.$queryRaw<RecoveryStartRow[]>`
    with invite as (
      select ii.*
      from public.interview_invites ii
      where ii.token = ${token}::text
        and coalesce(ii.access_type, '') = 'RECOVERY'
        and coalesce(ii.status, 'ACTIVE') = 'ACTIVE'
        and (ii.expires_at is null or ii.expires_at > now())
      limit 1
      for update
    ),
    parent_attempt as (
      select ia.*
      from public.interview_attempts ia
      join invite ii on ii.interview_id = ia.interview_id
      where ia.recovery_token_hash = ${tokenHash}::text
        and ia.recovery_token_used_at is null
        and upper(coalesce(ia.recovery_decision, '')) = 'APPROVED'
      limit 1
      for update
    ),
    interview_row as (
      select i.*, c.full_name as candidate_name
      from public.interviews i
      join invite ii on ii.interview_id = i.interview_id
      left join public.candidates c on c.candidate_id = i.candidate_id
      where i.recovery_allowed = true
        and i.recovery_used = false
        and coalesce(i.status, '') <> 'COMPLETED'
      limit 1
      for update
    ),
    previous_attempts as (
      select count(*)::int as attempts_used, coalesce(max(attempt_number), 0)::int as last_attempt_number
      from public.interview_attempts ia
      join interview_row i on i.interview_id = ia.interview_id
    ),
    created as (
      insert into public.interview_attempts (
        interview_id,
        attempt_number,
        status,
        started_at,
        ends_at,
        expected_questions,
        inherited_from_attempt_id,
        timer_remaining_seconds,
        transcript_status,
        recording_status,
        recovery_policy
      )
      select
        i.interview_id,
        p.last_attempt_number + 1,
        'started',
        now(),
        now() + make_interval(secs => greatest(coalesce(pa.timer_remaining_seconds, i.duration_minutes * 60, 1800), 60)),
        pa.expected_questions,
        pa.attempt_id,
        greatest(coalesce(pa.timer_remaining_seconds, i.duration_minutes * 60, 1800), 60),
        'INHERITED',
        'PENDING',
        jsonb_build_object('timer_mode', 'CONTINUE_REMAINING_TIME', 'parent_attempt_id', pa.attempt_id)
      from interview_row i, previous_attempts p, parent_attempt pa
      where p.attempts_used < coalesce(i.max_attempts, 2)
      returning *
    ),
    marked as (
      update public.interview_attempts pa
      set recovery_token_used_at = now()
      from parent_attempt src
      where pa.attempt_id = src.attempt_id
      returning pa.attempt_id
    ),
    used_invite as (
      update public.interview_invites ii
      set used_at = now(),
          attempts_used = coalesce(attempts_used, 0) + 1,
          status = 'USED',
          updated_at = now()
      from invite src
      where ii.invite_id = src.invite_id
      returning ii.invite_id
    ),
    interview_update as (
      update public.interviews i
      set recovery_used = true,
          status = 'RECOVERY_USED',
          final_status = 'RECOVERY_USED'
      from created c
      where i.interview_id = c.interview_id
      returning i.interview_id
    ),
    event_insert as (
      insert into public.interview_recovery_events (
        interview_id,
        attempt_id,
        inherited_from_attempt_id,
        event_type,
        classifier,
        reason,
        source,
        idempotency_key,
        metadata
      )
      select
        c.interview_id,
        c.attempt_id,
        c.inherited_from_attempt_id,
        'RECOVERY_USED',
        'NETWORK_ISSUE',
        'Candidate opened recruiter-approved recovery link',
        'candidate_calm_room',
        ${tokenHash}::text,
        jsonb_build_object('timer_remaining_seconds', c.timer_remaining_seconds)
      from created c
      on conflict (interview_id, idempotency_key)
      where idempotency_key is not null
      do nothing
      returning recovery_event_id
    )
    select
      c.attempt_id::text,
      c.interview_id::text,
      c.attempt_number,
      false as reused,
      i.candidate_id::text,
      i.candidate_name,
      c.ends_at
    from created c
    join interview_row i on i.interview_id = c.interview_id
    limit 1
  `;

  const created = rows[0];
  if (!created) {
    throw new Error("Recovery link is invalid, expired, already used, or no longer allowed");
  }

  logInterviewEvent("info", "interview.recovery_attempt_started", {
    attemptId: created.attempt_id,
    interviewId: created.interview_id,
  });

  return {
    ...created,
    serverNow: now.toISOString(),
  };
}
