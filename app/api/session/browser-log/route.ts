import { prisma } from "@/app/lib/prisma";
import { requireCandidateSession } from "@/app/lib/candidateSession";
import { assertUuid } from "@/app/lib/interviewReliability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RequestBody = {
  attemptId?: string;
  level?: string;
  message?: string;
  source?: string;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RequestBody;
    const { attemptId, level, message, source } = body;

    if (!attemptId || !message || (level !== "error" && level !== "warn")) {
      return Response.json(
        { error: "attemptId, a valid level ('error' or 'warn'), and message are required" },
        { status: 400 }
      );
    }

    assertUuid(attemptId, "attemptId");
    await requireCandidateSession(request, {
      attemptId,
      operation: "session.browser_log",
    });

    await prisma.$executeRaw`
      insert into public.interview_browser_logs (attempt_id, interview_id, level, message, source)
      select
        ${attemptId}::uuid,
        ia.interview_id,
        ${level}::text,
        ${message.slice(0, 2000)}::text,
        ${source ?? null}::text
      from public.interview_attempts ia
      where ia.attempt_id = ${attemptId}::uuid
    `;

    return Response.json({ ok: true });
  } catch (error) {
    // Diagnostic logging must never surface as a candidate-facing failure.
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to record browser log" },
      { status: 200 }
    );
  }
}
