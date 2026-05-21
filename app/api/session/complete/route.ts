import { finalizeInterviewAttempt } from "@/app/lib/interviewCompletion";
import { requireCandidateSession } from "@/app/lib/candidateSession";
import { assertUuid, logInterviewEvent } from "@/app/lib/interviewReliability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
