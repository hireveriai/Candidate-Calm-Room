import { finalizeInterviewAttempt } from "@/app/lib/interviewCompletion";
import { requireCandidateSession } from "@/app/lib/candidateSession";
import { assertUuid, logInterviewEvent } from "@/app/lib/interviewReliability";
import { finalizeActiveRecordings } from "@/app/lib/livekit/recordingLifecycle";
import { validateAndRepairCompletionTranscripts } from "@/app/lib/recordingTranscriptRepair";
import { canFinalizeWithTranscriptIntegrity } from "@/app/lib/completionTranscriptPolicy";
import { markInterviewCompletedPendingTranscriptReview } from "@/app/lib/completionPendingReview";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

type RequestBody = {
  attemptId?: string;
  currentPhase?: string | null;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RequestBody;
    const attemptId = body.attemptId?.trim();

    if (!attemptId) {
      return Response.json({ error: "attemptId is required" }, { status: 400 });
    }

    assertUuid(attemptId, "attemptId");
    await requireCandidateSession(request, {
      attemptId,
      operation: "session.complete",
    });

    await finalizeActiveRecordings(attemptId);
    const transcriptIntegrity = await validateAndRepairCompletionTranscripts(attemptId).catch((repairError: unknown) => {
      logInterviewEvent("error", "interview.transcript_auto_repair_failed", {
        attemptId,
        prismaFailure: repairError,
      });
      return null;
    });

    // Never convert missing transcription evidence into a completed zero-score
    // interview. Keep the attempt recoverable so the watchdog/background
    // repair path can retry the finalized recording.
    if (!canFinalizeWithTranscriptIntegrity(transcriptIntegrity)) {
      await markInterviewCompletedPendingTranscriptReview({
        attemptId,
        transcriptIntegrity,
      });

      logInterviewEvent("warn", "interview.completion_waiting_for_transcript", {
        attemptId,
        transcriptIntegrity,
      });

      return Response.json(
        {
          ok: true,
          status: "COMPLETED_TRANSCRIPT_REVIEW",
          message: "Interview completed. Transcript quality review will continue separately.",
          transcriptIntegrity,
        },
        { status: 202 }
      );
    }

    const result = await finalizeInterviewAttempt({
      attemptId,
      earlyExit: false,
      currentPhase: body.currentPhase ?? "closing",
    });

    return Response.json(result);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to finalize interview completion";

    logInterviewEvent("error", "interview.complete_failed", {
      prismaFailure: error,
    });

    return Response.json({ error: message }, { status: 500 });
  }
}
