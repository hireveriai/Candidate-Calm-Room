import { prisma } from "@/app/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RequestBody = {
  attemptId?: string;
  questionId?: string;
  content?: string;
  source?: "system" | "ai";
};

export async function POST(request: Request) {
  const startedAt = Date.now();

  try {
    console.log("[session/question] request:start");
    const body = (await request.json()) as RequestBody;
    const { attemptId, questionId, content, source } = body;

    if (!attemptId || !content || !source) {
      return Response.json(
        { error: "attemptId, content, and source are required" },
        { status: 400 }
      );
    }

    if (source !== "system" && source !== "ai") {
      return Response.json(
        { error: 'source must be "system" or "ai"' },
        { status: 400 }
      );
    }

    const dbStartedAt = Date.now();
    const sessionQuestion = await prisma.session_questions.create({
      data: {
        attempt_id: attemptId,
        question_id: questionId,
        content,
        source,
      },
    });

    console.log(
      `[session/question] db:create ${Date.now() - dbStartedAt}ms total=${Date.now() - startedAt}ms`
    );

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
