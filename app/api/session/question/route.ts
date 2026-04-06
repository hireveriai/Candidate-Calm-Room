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
    const fallbackContent =
      body.content?.trim() ||
      "Tell me about your experience and the work most relevant to this role.";
    const fallbackSource = body.source ?? "system";

    if (!attemptId) {
      return Response.json(
        { error: "attemptId is required" },
        { status: 400 }
      );
    }

    try {
      const dbStartedAt = Date.now();
      const rows = await prisma.$queryRaw<SessionQuestionRow[]>`
        select *
        from public.get_first_interview_question(${attemptId}::uuid)
      `;

      const sessionQuestion = rows[0];

      console.log(
        `[session/question] db:get-first ${Date.now() - dbStartedAt}ms total=${Date.now() - startedAt}ms`
      );

      if (sessionQuestion) {
        return Response.json(sessionQuestion);
      }
    } catch (dbError) {
      const message =
        dbError instanceof Error ? dbError.message : "Unknown first-question error";

      console.log(
        `[session/question] db:get-first failed after ${Date.now() - startedAt}ms: ${message}`
      );
    }

    const fallbackStartedAt = Date.now();
    const fallbackRows = await prisma.$queryRaw<SessionQuestionRow[]>`
      with next_order as (
        select coalesce(max(question_order), 0) + 1 as question_order
        from public.session_questions
        where attempt_id = ${attemptId}::uuid
      )
      insert into public.session_questions (
        attempt_id,
        question_id,
        content,
        source,
        question_kind,
        question_order
      )
      select
        ${attemptId}::uuid,
        null,
        ${fallbackContent},
        ${fallbackSource},
        'core',
        next_order.question_order
      from next_order
      returning
        session_question_id,
        question_id,
        content,
        source,
        question_kind,
        question_order,
        asked_at
    `;

    const fallbackQuestion = fallbackRows[0];

    console.log(
      `[session/question] fallback:create ${Date.now() - fallbackStartedAt}ms total=${Date.now() - startedAt}ms`
    );

    if (!fallbackQuestion) {
      return Response.json(
        { error: "No question available for this interview" },
        { status: 404 }
      );
    }

    return Response.json(fallbackQuestion);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create session question";

    console.log(
      `[session/question] error after ${Date.now() - startedAt}ms: ${message}`
    );

    return Response.json({ error: message }, { status: 500 });
  }
}
