import { prisma } from "@/app/lib/prisma";
import { assertUuid, logInterviewEvent } from "@/app/lib/interviewReliability";
import {
  HEARTBEAT_INTERVAL_MS,
  RECONNECT_GRACE_WINDOW_SECONDS,
  STALE_ATTEMPT_THRESHOLD_SECONDS,
  isFinalSessionStatus,
} from "@/app/lib/interviewSessionReliability";

type HeartbeatInput = {
  interviewId?: string | null;
  attemptId: string;
  sessionId?: string | null;
  timestamp?: string | null;
  reconnecting?: boolean;
};

type WatchdogResult = {
  scanned: number;
  abandoned: number;
  skipped: number;
  attempts: string[];
};

export async function recordInterviewHeartbeat(input: HeartbeatInput) {
  const attemptId = assertUuid(input.attemptId, "attemptId");

  const rows = await prisma.$queryRaw<
    {
      attempt_id: string;
      interview_id: string;
      status: string | null;
      reconnect_count: number | null;
      reconnect_events: unknown;
      last_disconnect_at: Date | null;
      total_disconnect_duration: number | null;
    }[]
  >`
    select
      ia.attempt_id,
      ia.interview_id,
      ia.status,
      ia.reconnect_count,
      ia.reconnect_events,
      ia.last_disconnect_at,
      ia.total_disconnect_duration
    from public.interview_attempts ia
    where ia.attempt_id = ${attemptId}::uuid
    limit 1
  `;

  const attempt = rows[0];
  if (!attempt) {
    throw new Error("Interview attempt not found");
  }

  if (input.interviewId?.trim() && input.interviewId.trim() !== attempt.interview_id) {
    throw new Error("interviewId does not match attempt");
  }

  if (isFinalSessionStatus(attempt.status)) {
    return {
      ok: true,
      finalized: true,
      status: attempt.status,
    };
  }

  const reconnectEvents = Array.isArray(attempt.reconnect_events)
    ? [...attempt.reconnect_events]
    : [];

  const shouldRecover =
    String(attempt.status ?? "").trim().toUpperCase() === "RECONNECTING";

  if (shouldRecover) {
    const reconnectLatencyMs = attempt.last_disconnect_at
      ? Date.now() - new Date(attempt.last_disconnect_at).getTime()
      : null;

    reconnectEvents.push({
      type: "reconnect_succeeded",
      at: new Date().toISOString(),
      source: "heartbeat",
      latency_ms: reconnectLatencyMs,
      metadata: {
        sessionId: input.sessionId ?? null,
      },
    });
  }

  await prisma.$executeRaw`
    update public.interview_attempts
    set status = case
          when upper(coalesce(status, '')) in ('STARTED', 'QUESTION_ACTIVE', 'READY', 'CREATED', 'RECONNECTING')
            then ${input.reconnecting ? "RECONNECTING" : "IN_PROGRESS"}::text
          when upper(coalesce(status, '')) in ('IN_PROGRESS', 'ANSWER_RECORDING', 'ANSWER_PROCESSING', 'QUESTION_GENERATING', 'FOLLOWUP_GENERATING', 'RECOVERY_ALLOWED', 'RECOVERY_USED', 'INTERRUPTED')
            then ${input.reconnecting ? "RECONNECTING" : "IN_PROGRESS"}::text
          when upper(coalesce(status, '')) in ('COMPLETING', 'FINALIZING')
            then status
          when upper(coalesce(status, '')) in ('COMPLETED', 'TERMINATED', 'ABANDONED', 'EXPIRED', 'FINALIZED', 'FAILED', 'TIME_EXPIRED')
            then status
          when nullif(trim(coalesce(status, '')), '') is null
            then ${input.reconnecting ? "RECONNECTING" : "IN_PROGRESS"}::text
          else ${input.reconnecting ? "RECONNECTING" : "IN_PROGRESS"}::text
        end,
        last_activity_at = now(),
        last_reconnect_at = case
          when ${shouldRecover} then now()
          else last_reconnect_at
        end,
        recovered_successfully = case
          when ${shouldRecover} then true
          else recovered_successfully
        end,
        reconnect_events = case
          when ${shouldRecover}
            then ${JSON.stringify(reconnectEvents)}::jsonb
          else reconnect_events
        end,
        total_disconnect_duration = case
          when ${shouldRecover} and last_disconnect_at is not null
            then coalesce(total_disconnect_duration, 0) + greatest(extract(epoch from (now() - last_disconnect_at))::int, 0)
          else total_disconnect_duration
        end,
        inactivity_seconds = case
          when last_activity_at is null then inactivity_seconds
          else greatest(extract(epoch from (now() - last_activity_at))::int, 0)
        end
    where attempt_id = ${attemptId}::uuid
  `;

  return {
    ok: true,
    finalized: false,
    status: input.reconnecting ? "RECONNECTING" : "IN_PROGRESS",
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  };
}

export async function markAttemptReconnecting(params: {
  attemptId: string;
  reason: string;
  source: string;
  metadata?: Record<string, unknown>;
}) {
  const attemptId = assertUuid(params.attemptId, "attemptId");
  const rows = await prisma.$queryRaw<
    {
      status: string | null;
      reconnect_count: number | null;
      reconnect_events: unknown;
      last_activity_at: Date | null;
    }[]
  >`
    select status, reconnect_count, reconnect_events, last_activity_at
    from public.interview_attempts
    where attempt_id = ${attemptId}::uuid
    limit 1
  `;

  const attempt = rows[0];
  if (!attempt || isFinalSessionStatus(attempt.status)) {
    return { ok: false, skipped: true };
  }

  const reconnectEvents = Array.isArray(attempt.reconnect_events)
    ? [...attempt.reconnect_events]
    : [];
  reconnectEvents.push({
    type: "disconnect_detected",
    at: new Date().toISOString(),
    reason: params.reason,
    source: params.source,
    metadata: params.metadata ?? {},
  });

  await prisma.$executeRaw`
    update public.interview_attempts
    set status = 'RECONNECTING',
        last_disconnect_at = now(),
        disconnect_reason = ${params.reason}::text,
        reconnect_count = coalesce(reconnect_count, 0) + 1,
        recovered_successfully = false,
        reconnect_events = ${JSON.stringify(reconnectEvents)}::jsonb
    where attempt_id = ${attemptId}::uuid
      and upper(coalesce(status, '')) not in ('COMPLETED', 'TERMINATED', 'ABANDONED', 'EXPIRED', 'FINALIZED', 'FAILED', 'TIME_EXPIRED')
  `;

  logInterviewEvent("warn", "interview.reconnecting", {
    attemptId,
    reason: params.reason,
    state: attempt.status,
    nextState: "RECONNECTING",
  });

  return { ok: true };
}

export async function runInterviewWatchdog() {
  const staleRows = await prisma.$queryRaw<
    {
      attempt_id: string;
      interview_id: string;
      status: string | null;
      last_activity_at: Date | null;
      last_disconnect_at: Date | null;
      reconnect_count: number | null;
    }[]
  >`
    select
      attempt_id,
      interview_id,
      status,
      last_activity_at,
      last_disconnect_at,
      reconnect_count
    from public.interview_attempts
    where upper(coalesce(status, '')) in ('STARTED', 'IN_PROGRESS', 'RECONNECTING', 'QUESTION_ACTIVE', 'ANSWER_RECORDING', 'ANSWER_PROCESSING', 'FOLLOWUP_GENERATING', 'READY')
      and (
        last_activity_at is null
        or last_activity_at < now() - (${STALE_ATTEMPT_THRESHOLD_SECONDS} * interval '1 second')
      )
    order by coalesce(last_activity_at, started_at) asc
    limit 100
  `;

  let abandoned = 0;
  let skipped = 0;
  const attempts: string[] = [];

  for (const row of staleRows) {
    const recentReconnect =
      row.last_disconnect_at &&
      Date.now() - new Date(row.last_disconnect_at).getTime() <
        RECONNECT_GRACE_WINDOW_SECONDS * 1000;

    if (
      String(row.status ?? "").trim().toUpperCase() === "RECONNECTING" &&
      recentReconnect &&
      (row.reconnect_count ?? 0) < 5
    ) {
      skipped += 1;
      continue;
    }

    const result = await prisma.$executeRaw`
      update public.interview_attempts
      set status = 'ABANDONED',
          ended_at = coalesce(ended_at, now()),
          termination_type = 'watchdog_timeout',
          inactivity_seconds = case
            when last_activity_at is null then ${STALE_ATTEMPT_THRESHOLD_SECONDS}::int
            else greatest(extract(epoch from (now() - last_activity_at))::int, 0)
          end,
          disconnect_reason = 'heartbeat_timeout',
          termination_detected_at = coalesce(termination_detected_at, now()),
          recovered_successfully = false
      where attempt_id = ${row.attempt_id}::uuid
        and upper(coalesce(status, '')) not in ('COMPLETED', 'TERMINATED', 'ABANDONED', 'EXPIRED', 'FINALIZED', 'FAILED', 'TIME_EXPIRED')
    `;

    if (Number(result) > 0) {
      abandoned += 1;
      attempts.push(row.attempt_id);
      logInterviewEvent("warn", "watchdog.abandoned_attempt", {
        attemptId: row.attempt_id,
        interviewId: row.interview_id,
        state: row.status,
        nextState: "ABANDONED",
      });
    } else {
      skipped += 1;
    }
  }

  return {
    scanned: staleRows.length,
    abandoned,
    skipped,
    attempts,
  } satisfies WatchdogResult;
}
