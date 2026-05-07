import { recordInterviewInterruption } from "@/app/lib/interviewRecovery";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RequestBody = {
  attemptId?: string;
  classifier?: string;
  reason?: string;
  source?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RequestBody;

    if (!body.attemptId?.trim()) {
      return Response.json({ error: "attemptId is required" }, { status: 400 });
    }

    const result = await recordInterviewInterruption({
      attemptId: body.attemptId,
      classifier: body.classifier,
      reason: body.reason,
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      metadata: body.metadata ?? {},
    });

    return Response.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to record interruption";
    return Response.json({ error: message }, { status: 500 });
  }
}
