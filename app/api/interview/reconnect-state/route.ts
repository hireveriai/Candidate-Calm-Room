import { markAttemptReconnecting } from "@/app/lib/interviewWatchdog";
import { requireCandidateSession } from "@/app/lib/candidateSession";
import { logInterviewEvent } from "@/app/lib/interviewReliability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RequestBody = {
  attemptId?: string;
  reason?: string;
  source?: string;
  metadata?: Record<string, unknown>;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RequestBody;

    if (!body.attemptId?.trim()) {
      return Response.json({ error: "attemptId is required" }, { status: 400 });
    }
    await requireCandidateSession(request, {
      attemptId: body.attemptId.trim(),
      operation: "interview.reconnect_state",
    });

    const result = await markAttemptReconnecting({
      attemptId: body.attemptId.trim(),
      reason: body.reason?.trim() || "connection_interrupted",
      source: body.source?.trim() || "candidate_calm_room",
      metadata: body.metadata ?? {},
    });

    return Response.json(result);
  } catch (error) {
    logInterviewEvent("error", "interview.reconnect_state_failed", {
      prismaFailure: error,
    });

    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to update reconnect state",
      },
      { status: 500 }
    );
  }
}
