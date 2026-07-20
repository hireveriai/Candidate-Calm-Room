import { finalizeInterviewAttempt } from "@/app/lib/interviewCompletion";
import { requireCandidateSession } from "@/app/lib/candidateSession";
import { assertUuid, logInterviewEvent } from "@/app/lib/interviewReliability";
import { finalizeActiveRecordings } from "@/app/lib/livekit/recordingLifecycle";
import { validateAndRepairCompletionTranscripts } from "@/app/lib/recordingTranscriptRepair";
import { prisma } from "@/app/lib/prisma";

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

    await finalizeActiveRecordings(attemptId);
    await validateAndRepairCompletionTranscripts(attemptId).catch((repairError: unknown) => {
      logInterviewEvent("error", "interview.transcript_auto_repair_failed", {
        attemptId,
        prismaFailure: repairError,
      });
    });

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
