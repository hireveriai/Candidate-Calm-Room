import { finalizeInterviewAttempt } from "@/app/lib/interviewCompletion";
import { requireCandidateSession } from "@/app/lib/candidateSession";
import { assertUuid, logInterviewEvent } from "@/app/lib/interviewReliability";
import { finalizeActiveRecordings } from "@/app/lib/livekit/recordingLifecycle";
import { validateAndRepairCompletionTranscripts } from "@/app/lib/recordingTranscriptRepair";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

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
      terminationType: normalizeTerminationType(body.terminationType),
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
