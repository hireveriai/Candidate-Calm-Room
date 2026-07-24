import { recordInterviewHeartbeat } from "@/app/lib/interviewWatchdog";
import { requireCandidateSession } from "@/app/lib/candidateSession";
import { logInterviewEvent } from "@/app/lib/interviewReliability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RequestBody = {
  interviewId?: string;
  attemptId?: string;
  sessionId?: string;
  timestamp?: string;
  reconnecting?: boolean;
  sessionQuestionId?: string | null;
  questionId?: string | null;
  transcriptBuffer?: string | null;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RequestBody;

    if (!body.attemptId?.trim()) {
      return Response.json({ error: "attemptId is required" }, { status: 400 });
    }
    await requireCandidateSession(request, {
      attemptId: body.attemptId.trim(),
      interviewId: body.interviewId?.trim() ?? null,
      operation: "interview.heartbeat",
    });

    const result = await recordInterviewHeartbeat({
      interviewId: body.interviewId?.trim() ?? null,
      attemptId: body.attemptId.trim(),
      sessionId: body.sessionId?.trim() ?? null,
      timestamp: body.timestamp ?? null,
      reconnecting: Boolean(body.reconnecting),
      sessionQuestionId: body.sessionQuestionId?.trim() ?? null,
      questionId: body.questionId?.trim() ?? null,
      transcriptBuffer: body.transcriptBuffer ?? null,
    });

    return Response.json(result);
  } catch (error) {
    logInterviewEvent("error", "interview.heartbeat_failed", {
      prismaFailure: error,
    });

    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to process interview heartbeat",
      },
      { status: 500 }
    );
  }
}
