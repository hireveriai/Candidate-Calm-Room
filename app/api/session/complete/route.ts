import { finalizeInterviewAttempt } from "@/app/lib/interviewCompletion";

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

    return Response.json({ error: message }, { status: 500 });
  }
}
