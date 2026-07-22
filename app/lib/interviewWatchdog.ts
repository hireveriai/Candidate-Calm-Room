import { prisma } from "@/app/lib/prisma";
import { finalizeInterviewAttempt } from "@/app/lib/interviewCompletion";
import { assertUuid, logInterviewEvent } from "@/app/lib/interviewReliability";
import { finalizeActiveRecordings } from "@/app/lib/livekit/recordingLifecycle";
import { validateAndRepairCompletionTranscripts } from "@/app/lib/recordingTranscriptRepair";
import {
  HEARTBEAT_INTERVAL_MS,
  RECONNECT_GRACE_WINDOW_SECONDS,
  SESSION_END_BUFFER_SECONDS,
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

type CompletionEvidenceRow = {
  expected_questions: number | null;
  session_questions: number;
  answer_rows: number;
  non_empty_answers: number;
  completed_recordings: number;
  recordings_with_transcript: number;
};

async function loadCompletionEvidence(attemptId: string) {
  const rows = await prisma.$queryRaw<CompletionEvidenceRow[]>`
    select
      coalesce(
        ia.expected_questions,
        i.question_count,
        (
          select count(*)
          from public.interview_questions iq
          where iq.interview_id = ia.interview_id
        )::int,
        0
      )::int as expected_questions,
      (
        select count(*)
        from public.interview_recordings ir
        where ir.attempt_id = ia.attempt_id
          and lower(coalesce(ir.status, '')) = 'completed'
          and nullif(trim(coalesce(ir.file_path, ir.audio_url, ir.video_url, '')), '') is not null
      )::int as completed_recordings,
      (
        select count(*)
        from public.session_questions sq
        where sq.attempt_id = ia.attempt_id
      )::int as session_questions,
      (
        select count(*)
        from public.interview_answers ans
        where ans.attempt_id = ia.attempt_id
      )::int as answer_rows,
      (
        select count(*)
        from public.interview_answers ans
        where ans.attempt_id = ia.attempt_id
          and nullif(trim(coalesce(ans.answer_text, '')), '') is not null
          and lower(trim(ans.answer_text)) <> 'no response provided.'
      )::int as non_empty_answers,
      (
        select count(*)
        from public.interview_recordings ir
        where ir.attempt_id = ia.attempt_id
          and nullif(trim(coalesce(ir.transcript, '')), '') is not null
      )::int as recordings_with_transcript
    from public.interview_attempts ia
    join public.interviews i
      on i.interview_id = ia.interview_id
    where ia.attempt_id = ${attemptId}::uuid
    limit 1
  `;

  return rows[0] ?? null;
}

function hasCompletionEvidence(evidence: CompletionEvidenceRow | null) {
  if (!evidence) {
    return false;
  }

  const expectedQuestions = Math.max(evidence.expected_questions ?? 0, 1);
  const askedEnough = evidence.session_questions >= expectedQuestions;
  const answeredEnough =
    evidence.non_empty_answers >= Math.max(expectedQuestions - 1, 1) ||
    (evidence.answer_rows >= expectedQuestions && evidence.completed_recordings > 0);

  // A missing live transcript is recoverable from the finalized recording.
  // Requiring a transcript here caused fully answered attempts to be marked
  // abandoned before the recording transcript repair could run.
  return askedEnough && answeredEnough;
}

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
    !input.reconnecting && attempt.last_disconnect_at !== null;

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
          when upper(coalesce(status, '')) in ('COMPLETING', 'FINALIZING')
            then status
          when upper(coalesce(status, '')) in ('COMPLETED', 'TERMINATED', 'ABANDONED', 'EXPIRED', 'FINALIZED', 'FAILED', 'TIME_EXPIRED')
            then status
          when nullif(trim(coalesce(status, '')), '') is null
            then 'QUESTION_ACTIVE'
          else status
        end,
        last_activity_at = now(),
        last_reconnect_at = case
          when ${shouldRecover} then now()
          else last_reconnect_at
        end,
        last_disconnect_at = case
          when ${shouldRecover} then null
          else last_disconnect_at
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

  if (!input.reconnecting) {
    const restoredInterviews = await prisma.$executeRaw`
      update public.interviews parent
      set status = 'IN_PROGRESS',
          final_status = null
      where parent.interview_id = ${attempt.interview_id}::uuid
        and upper(coalesce(parent.status, '')) = 'INTERRUPTED'
        and exists (
          select 1
          from public.interview_attempts active_attempt
          where active_attempt.attempt_id = ${attemptId}::uuid
            and upper(coalesce(active_attempt.status, '')) not in (
              'COMPLETED', 'TERMINATED', 'ABANDONED', 'EXPIRED',
              'FINALIZED', 'FAILED', 'TIME_EXPIRED'
            )
        )
    `;

    if (Number(restoredInterviews) > 0) {
      logInterviewEvent("info", "interview.heartbeat_recovered", {
        attemptId,
        interviewId: attempt.interview_id,
        state: "INTERRUPTED",
        nextState: "IN_PROGRESS",
      });
    }
  }

  return {
    ok: true,
    finalized: false,
    status: input.reconnecting ? "RECONNECTING" : attempt.status ?? "QUESTION_ACTIVE",
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
  const lastReconnectEvent = reconnectEvents.at(-1);
  const lastReconnectRecord =
    lastReconnectEvent && typeof lastReconnectEvent === "object"
      ? lastReconnectEvent as Record<string, unknown>
      : null;
  const lastReconnectAt = lastReconnectRecord?.at
    ? new Date(String(lastReconnectRecord.at)).getTime()
    : 0;
  const duplicateDisconnect =
    lastReconnectRecord?.type === "disconnect_detected" &&
    lastReconnectRecord?.source === params.source &&
    lastReconnectRecord?.reason === params.reason &&
    Number.isFinite(lastReconnectAt) &&
    Date.now() - lastReconnectAt < 30_000;

  if (duplicateDisconnect) {
    return { ok: true, duplicate: true };
  }

  reconnectEvents.push({
    type: "disconnect_detected",
    at: new Date().toISOString(),
    reason: params.reason,
    source: params.source,
    metadata: params.metadata ?? {},
  });

  await prisma.$executeRaw`
    update public.interview_attempts
    set last_disconnect_at = coalesce(last_disconnect_at, now()),
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
    nextState: attempt.status,
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
      ends_at: Date | null;
      close_reason: "STALE_HEARTBEAT" | "SESSION_TIME_EXPIRED";
    }[]
  >`
    select
      attempt_id,
      interview_id,
      status,
      last_activity_at,
      last_disconnect_at,
      reconnect_count,
      ends_at,
      case
        when ends_at is not null
          and ends_at < now() - (${SESSION_END_BUFFER_SECONDS} * interval '1 second')
          then 'SESSION_TIME_EXPIRED'
        else 'STALE_HEARTBEAT'
      end as close_reason
    from public.interview_attempts
    where upper(coalesce(status, '')) in (
        'STARTED',
        'IN_PROGRESS',
        'RECONNECTING',
        'QUESTION_ACTIVE',
        'ANSWER_RECORDING',
        'ANSWER_PROCESSING',
        'QUESTION_GENERATING',
        'FOLLOWUP_GENERATING',
        'READY',
        'CREATED',
        'RECOVERY_USED',
        'INTERRUPTED',
        'COMPLETING',
        'FINALIZING',
        'COMPLETED',
        'ABANDONED',
        'TIME_EXPIRED'
      )
      and (
        upper(coalesce(status, '')) <> 'COMPLETED'
        or (
          upper(coalesce(transcript_status, 'PENDING')) in ('PENDING', 'PARTIAL', 'FAILED')
          and coalesce(
            nullif(termination_metadata #>> '{transcript_integrity,checkedAt}', '')::timestamptz,
            'epoch'::timestamptz
          ) < now() - interval '1 hour'
        )
      )
      and (
        upper(coalesce(status, '')) not in ('ABANDONED', 'TIME_EXPIRED')
        or exists (
          select 1
          from public.interviews interrupted_interview
          where interrupted_interview.interview_id = interview_attempts.interview_id
            and (
              upper(coalesce(interrupted_interview.status, '')) = 'INTERRUPTED'
              or upper(coalesce(interrupted_interview.final_status, '')) = 'INTERRUPTED'
              or (
                upper(coalesce(interrupted_interview.status, '')) = 'COMPLETED'
                and upper(coalesce(interrupted_interview.final_status, '')) in ('ABANDONED', 'TIME_EXPIRED')
              )
            )
        )
      )
      and (
        (
          ends_at is not null
          and ends_at < now() - (${SESSION_END_BUFFER_SECONDS} * interval '1 second')
        )
        or (
          coalesce(last_activity_at, started_at) < now() - (${STALE_ATTEMPT_THRESHOLD_SECONDS} * interval '1 second')
        )
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

    if (recentReconnect && (row.reconnect_count ?? 0) < 5) {
      skipped += 1;
      continue;
    }

    const completionEvidence = await loadCompletionEvidence(row.attempt_id);
    const completionWasCommitted = ["COMPLETING", "FINALIZING"].includes(
      (row.status ?? "").trim().toUpperCase()
    );
    if (completionWasCommitted || hasCompletionEvidence(completionEvidence)) {
      try {
        if (
          hasCompletionEvidence(completionEvidence) &&
          ["ABANDONED", "TIME_EXPIRED", "INTERRUPTED"].includes(
            (row.status ?? "").trim().toUpperCase()
          )
        ) {
          await prisma.$executeRaw`
            update public.interview_attempts
            set status = 'COMPLETING',
                termination_type = 'completed',
                early_exit = false,
                last_activity_at = now()
            where attempt_id = ${row.attempt_id}::uuid
          `;
          logInterviewEvent("info", "watchdog.historical_completion_reopened", {
            attemptId: row.attempt_id,
            interviewId: row.interview_id,
            state: row.status,
            nextState: "COMPLETING",
            completionEvidence,
          });
        }

        await finalizeActiveRecordings(row.attempt_id);
        await validateAndRepairCompletionTranscripts(row.attempt_id).catch((error: unknown) => {
          logInterviewEvent("error", "watchdog.transcript_repair_failed", {
            attemptId: row.attempt_id,
            interviewId: row.interview_id,
            prismaFailure: error,
          });
        });
        await finalizeInterviewAttempt({
          attemptId: row.attempt_id,
          earlyExit: false,
          terminationType: row.close_reason === "SESSION_TIME_EXPIRED" ? "timeout" : "completed",
          currentPhase: "closing",
        });

        skipped += 1;
        logInterviewEvent("info", "watchdog.finalized_evidence_complete_attempt", {
          attemptId: row.attempt_id,
          interviewId: row.interview_id,
          state: row.status,
          nextState: "COMPLETED",
          completionEvidence,
        });
        continue;
      } catch (error) {
        logInterviewEvent("error", "watchdog.evidence_completion_failed", {
          attemptId: row.attempt_id,
          interviewId: row.interview_id,
          state: row.status,
          nextState: "ABANDONED",
          completionEvidence,
          prismaFailure: error,
        });
      }
    }

    const finalStatus =
      row.close_reason === "SESSION_TIME_EXPIRED" ? "TIME_EXPIRED" : "ABANDONED";
    const terminationType =
      row.close_reason === "SESSION_TIME_EXPIRED" ? "timeout" : "watchdog_timeout";
    const disconnectReason =
      row.close_reason === "SESSION_TIME_EXPIRED" ? "session_time_expired" : "heartbeat_timeout";

    const updatedRows = await prisma.$transaction(async (tx: typeof prisma) => {
      const result = await tx.$executeRaw`
        update public.interview_attempts
        set status = ${finalStatus}::text,
            ended_at = coalesce(ended_at, least(now(), coalesce(ends_at, now()))),
            termination_type = ${terminationType}::text,
            inactivity_seconds = case
              when ${row.close_reason}::text = 'SESSION_TIME_EXPIRED' then
                greatest(extract(epoch from (now() - coalesce(ends_at, now())))::int, 0)
              else greatest(extract(epoch from (now() - coalesce(last_activity_at, started_at)))::int, 0)
            end,
            disconnect_reason = ${disconnectReason}::text,
            termination_detected_at = coalesce(termination_detected_at, now()),
            recovered_successfully = false,
            early_exit = case
              when ${row.close_reason}::text = 'SESSION_TIME_EXPIRED' then early_exit
              else true
            end
        where attempt_id = ${row.attempt_id}::uuid
          and upper(coalesce(status, '')) not in ('COMPLETED', 'TERMINATED', 'ABANDONED', 'EXPIRED', 'FINALIZED', 'FAILED', 'TIME_EXPIRED')
      `;

      if (Number(result) > 0) {
        await tx.$executeRaw`
          update public.interviews i
          set status = 'INTERRUPTED',
              final_status = 'INTERRUPTED',
              failure_reason = coalesce(
                failure_reason,
                case
                  when ${row.close_reason}::text = 'SESSION_TIME_EXPIRED' then 'SESSION_TIME_EXPIRED'
                  else 'HEARTBEAT_TIMEOUT'
                end
              )
          where i.interview_id = ${row.interview_id}::uuid
            and not exists (
              select 1
              from public.interview_attempts active
              where active.interview_id = i.interview_id
                and active.attempt_id <> ${row.attempt_id}::uuid
                and upper(coalesce(active.status, '')) not in ('COMPLETED', 'TERMINATED', 'ABANDONED', 'EXPIRED', 'FINALIZED', 'FAILED', 'TIME_EXPIRED')
            )
        `;
      }

      return result;
    });

    if (Number(updatedRows) > 0) {
      await finalizeActiveRecordings(row.attempt_id).catch((error: unknown) => {
        logInterviewEvent("error", "watchdog.recording_finalize_failed", {
          attemptId: row.attempt_id,
          interviewId: row.interview_id,
          prismaFailure: error,
        });
      });

      abandoned += 1;
      attempts.push(row.attempt_id);
      logInterviewEvent("warn", "watchdog.abandoned_attempt", {
        attemptId: row.attempt_id,
        interviewId: row.interview_id,
        state: row.status,
        nextState: finalStatus,
        timerState: {
          endsAt: row.ends_at,
          closeReason: row.close_reason,
          bufferSeconds: SESSION_END_BUFFER_SECONDS,
        },
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
