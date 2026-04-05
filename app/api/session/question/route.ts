import { prisma } from "@/app/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RequestBody = {
  attemptId?: string;
  questionId?: string;
  content?: string;
  source?: "system" | "ai";
};

type SessionQuestionRow = {
  session_question_id: string;
  question_id: string | null;
  content: string;
  source: string;
  question_kind: string;
  question_order: number;
  asked_at: Date | null;
};

export async function POST(request: Request) {
  const startedAt = Date.now();

  try {
    console.log("[session/question] request:start");
    const body = (await request.json()) as RequestBody;
    const { attemptId } = body;

    if (!attemptId) {
      return Response.json(
        { error: "attemptId is required" },
        { status: 400 }
      );
    }

    const dbStartedAt = Date.now();
    const rows = await prisma.$queryRaw<SessionQuestionRow[]>`
      select *
      from public.get_first_interview_question(${attemptId}::uuid)
    `;

    const sessionQuestion = rows[0];

    console.log(
      `[session/question] db:get-first ${Date.now() - dbStartedAt}ms total=${Date.now() - startedAt}ms`
    );

    if (!sessionQuestion) {
      return Response.json(
        { error: "No question available for this interview" },
        { status: 404 }
      );
    }

    return Response.json(sessionQuestion);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create session question";

    console.log(
      `[session/question] error after ${Date.now() - startedAt}ms: ${message}`
    );

    return Response.json({ error: message }, { status: 500 });
  }
}
