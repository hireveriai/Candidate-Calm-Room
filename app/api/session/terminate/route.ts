import { finalizeInterviewAttempt } from "@/app/lib/interviewCompletion";
import { after } from "next/server";
import { requireCandidateSession } from "@/app/lib/candidateSession";
import { assertUuid, logInterviewEvent } from "@/app/lib/interviewReliability";
import { finalizeActiveRecordings } from "@/app/lib/livekit/recordingLifecycle";
import { validateAndRepairCompletionTranscripts } from "@/app/lib/recordingTranscriptRepair";
import { prisma } from "@/app/lib/prisma";
import { getInterviewCompletionEligibility } from "@/app/lib/interviewCompletionEvidence";
import { canFinalizeWithTranscriptIntegrity } from "@/app/lib/completionTranscriptPolicy";
import { markInterviewCompletedPendingTranscriptReview } from "@/app/lib/completionPendingReview";
import { isFinalSessionStatus } from "@/app/lib/interviewSessionReliability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

type TerminationType =
  | "manual_exit"
  | "tab_close"
  | "disconnect"
  | "timeout"
  | "watchdog_timeout"
  | "network_disconnect_timeout";

type RequestBody = {
  attemptId?: string;
  terminationType?: string;
  currentPhase?: string;
};

async function parseBody(request: Request): Promise<RequestBody> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    return (await request.json()) as RequestBody;
  }

  const raw = await request.text();
  if (!raw.trim()) {
    return {};
  }

  return JSON.parse(raw) as RequestBody;
}

function normalizeTerminationType(value: string | undefined): TerminationType {
  switch (value) {
    case "manual_exit":
    case "tab_close":
    case "disconnect":
    case "timeout":
    case "watchdog_timeout":
    case "network_disconnect_timeout":
      return value;
    default:
      return "manual_exit";
  }
}

export async function POST(request: Request) {
  try {
    const body = await parseBody(request);
    const attemptId = body.attemptId?.trim();

    if (!attemptId) {
      return Response.json({ error: "attemptId is required" }, { status: 400 });
    }

    assertUuid(attemptId, "attemptId");
    await requireCandidateSession(request, {
      attemptId,
      operation: "session.terminate",
    });

    const terminationType = normalizeTerminationType(body.terminationType);
    if (terminationType === "timeout") {
      const rows = await prisma.$queryRaw<Array<{ ends_at: Date | string | null }>>`
        select ends_at
        from public.interview_attempts
        where attempt_id = ${attemptId}::uuid
        limit 1
      `;
      const endsAt = rows[0]?.ends_at ? new Date(rows[0].ends_at).getTime() : null;
      if (endsAt && Number.isFinite(endsAt) && Date.now() < endsAt) {
        logInterviewEvent("warn", "interview.premature_timeout_rejected", {
          attemptId,
          state: "QUESTION_ACTIVE",
          nextState: "QUESTION_ACTIVE",
          timerState: { endsAt: new Date(endsAt).toISOString() },
        });
        return Response.json(
          {
            error: "The interview session has not reached its overall time limit.",
            code: "PREMATURE_SESSION_TIMEOUT",
          },
          { status: 409 }
        );
      }
    }

    const completionEligibility =
      await getInterviewCompletionEligibility(attemptId);
    if (completionEligibility.eligible) {
      await prisma.$executeRaw`
        update public.interview_attempts
        set status = 'COMPLETING',
            current_phase = 'closing',
            termination_type = 'completed',
            early_exit = false,
            last_activity_at = now()
        where attempt_id = ${attemptId}::uuid
          and upper(coalesce(status, '')) not in (
            'COMPLETED', 'TERMINATED', 'ABANDONED', 'EXPIRED',
            'FINALIZED', 'FAILED', 'TIME_EXPIRED', 'FINALIZING'
          )
      `;

      logInterviewEvent("info", "interview.late_termination_converted_to_completion", {
        attemptId,
        state: "QUESTION_ACTIVE",
        nextState: "COMPLETING",
        terminationType,
        completionEvidence: completionEligibility.evidence,
      });

      after(async () => {
        try {
          await finalizeActiveRecordings(attemptId);
          const transcriptIntegrity =
            await validateAndRepairCompletionTranscripts(attemptId).catch(
              (repairError: unknown) => {
                logInterviewEvent(
                  "error",
                  "interview.transcript_auto_repair_failed",
                  {
                    attemptId,
                    prismaFailure: repairError,
                  }
                );
                return null;
              }
            );

          if (!canFinalizeWithTranscriptIntegrity(transcriptIntegrity)) {
            await markInterviewCompletedPendingTranscriptReview({
              attemptId,
              transcriptIntegrity,
            });
            return;
          }

          await finalizeInterviewAttempt({
            attemptId,
            earlyExit: false,
            terminationType: "completed",
            currentPhase: "closing",
          });
        } catch (completionError) {
          logInterviewEvent(
            "error",
            "interview.late_termination_completion_deferred",
            {
              attemptId,
              state: "COMPLETING",
              nextState: "FINALIZING",
              prismaFailure: completionError,
            }
          );
        }
      });

      return Response.json(
        {
          completed: true,
          early_exit: false,
          completion_percentage: 1,
          reliability_score: 100,
          termination_type: "completed",
          status: "COMPLETING",
        },
        { status: 202 }
      );
    }

    const existingAttempts = await prisma.$queryRaw<
      Array<{
        status: string | null;
        termination_type: string | null;
        completion_percentage: number | string | null;
        reliability_score: number | string | null;
      }>
    >`
      select status, termination_type, completion_percentage, reliability_score
      from public.interview_attempts
      where attempt_id = ${attemptId}::uuid
      limit 1
    `;
    const existingAttempt = existingAttempts[0];
    if (isFinalSessionStatus(existingAttempt?.status)) {
      // A late/retried terminate call (common on mobile, where a network
      // blip triggers this after the interview already finished server-side)
      // must not report a successfully completed attempt as interrupted just
      // because this particular request did not perform the finalization.
      const normalizedStatus = (existingAttempt?.status ?? "").toUpperCase();
      const alreadyCompletedSuccessfully =
        normalizedStatus === "COMPLETED" || normalizedStatus === "FINALIZED";

      logInterviewEvent("info", "interview.late_termination_preserved", {
        attemptId,
        state: existingAttempt?.status ?? null,
        nextState: existingAttempt?.status ?? null,
        terminationType,
        existingTerminationType: existingAttempt?.termination_type ?? null,
        alreadyCompletedSuccessfully,
      });

      return Response.json({
        completed: alreadyCompletedSuccessfully,
        preserved: true,
        status: existingAttempt?.status ?? null,
        termination_type: existingAttempt?.termination_type ?? null,
        early_exit: !alreadyCompletedSuccessfully,
        completion_percentage: alreadyCompletedSuccessfully
          ? 1
          : Number(existingAttempt?.completion_percentage ?? 0),
        reliability_score: Number(existingAttempt?.reliability_score ?? 0),
      });
    }

    await finalizeActiveRecordings(attemptId);
    const transcriptIntegrity = await validateAndRepairCompletionTranscripts(attemptId).catch(
      (repairError: unknown) => {
        logInterviewEvent("error", "interview.transcript_auto_repair_failed", {
          attemptId,
          prismaFailure: repairError,
        });
        return null;
      }
    );

    // This path handles manual exits, tab closes, and other early
    // terminations. Previously it discarded the transcript-integrity result
    // and always finalized as a scored COMPLETED interview -- including
    // cases with zero real answers (e.g. a total camera/mic capture
    // failure), which showed recruiters a false "Completed" with no
    // recording, no transcript, and no score behind it. Route those to the
    // same pending-review state the watchdog already uses instead of
    // silently finalizing as a success.
    if (!canFinalizeWithTranscriptIntegrity(transcriptIntegrity)) {
      await markInterviewCompletedPendingTranscriptReview({
        attemptId,
        transcriptIntegrity,
      });
      return Response.json({
        completed: false,
        early_exit: true,
        completion_percentage: 0,
        reliability_score: 0,
        termination_type: terminationType,
        status: "TRANSCRIPT_REVIEW_REQUIRED",
      });
    }

    const result = await finalizeInterviewAttempt({
      attemptId,
      earlyExit: true,
      terminationType,
      currentPhase: body.currentPhase ?? null,
    });

    return Response.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to terminate interview";

    logInterviewEvent("error", "interview.terminate_failed", {
      prismaFailure: error,
    });

    return Response.json({ error: message }, { status: 500 });
  }
}
