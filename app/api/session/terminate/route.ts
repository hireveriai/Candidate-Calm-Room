import { finalizeInterviewAttempt } from "@/app/lib/interviewCompletion";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type TerminationType =
  | "manual_exit"
  | "tab_close"
  | "disconnect"
  | "timeout";

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

    return Response.json({ error: message }, { status: 500 });
  }
}
