import { finalizeInterviewAttempt } from "@/app/lib/interviewCompletion";
import { requireCandidateSession } from "@/app/lib/candidateSession";
import { assertUuid, logInterviewEvent } from "@/app/lib/interviewReliability";
import { finalizeActiveRecordings } from "@/app/lib/livekit/recordingLifecycle";
import { validateAndRepairCompletionTranscripts } from "@/app/lib/recordingTranscriptRepair";
import { prisma } from "@/app/lib/prisma";

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
    if (!transcriptIntegrity || transcriptIntegrity.remainingIssues > 0) {
      await prisma.$executeRaw`
        update public.interview_attempts
        set status = 'COMPLETING',
            transcript_status = 'PARTIAL',
            last_activity_at = now(),
            termination_metadata = jsonb_set(
              coalesce(termination_metadata, '{}'::jsonb),
              '{transcript_integrity}',
              ${JSON.stringify(transcriptIntegrity ?? {
                status: "needs_review",
                reason: "transcript_repair_unavailable",
              })}::jsonb,
              true
            )
        where attempt_id = ${attemptId}::uuid
          and upper(coalesce(status, '')) not in ('COMPLETED', 'FINALIZED')
      `;

      logInterviewEvent("warn", "interview.completion_waiting_for_transcript", {
        attemptId,
        transcriptIntegrity,
      });

      return Response.json(
        {
          ok: true,
          status: "TRANSCRIPT_PROCESSING",
          message: "Interview responses were saved and transcription recovery is still processing.",
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
