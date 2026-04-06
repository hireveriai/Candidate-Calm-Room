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

function hasMissingFunctionError(error: unknown, functionName: string) {
  return (
    error instanceof Error &&
    error.message.includes("Raw query failed") &&
    error.message.includes(functionName) &&
    error.message.includes("does not exist")
  );
}

export async function POST(request: Request) {
  const startedAt = Date.now();

  try {
    console.log("[session/question] request:start");
    const body = (await request.json()) as RequestBody;
    const { attemptId, content, source } = body;
    const fallbackContent =
      content?.trim() ||
      "Tell me about your experience and the work most relevant to this role.";
    const fallbackSource = source ?? "system";

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
    } catch (error) {
      if (!hasMissingFunctionError(error, "public.get_first_interview_question")) {
        throw error;
      }
    }

    const fallbackStartedAt = Date.now();
    const existingQuestion = await prisma.session_questions.findFirst({
      where: {
        attempt_id: attemptId,
      },
      orderBy: [
        {
          asked_at: "desc",
        },
        {
          session_question_id: "desc",
        },
      ],
    });

    if (existingQuestion) {
      return Response.json({
        ...existingQuestion,
        question_kind: existingQuestion.question_id ? "core" : "follow_up",
        question_order: 1,
      } satisfies SessionQuestionRow);
    }

    const attempt = await prisma.interview_attempts.findUnique({
      where: {
        attempt_id: attemptId,
      },
      select: {
        interview_id: true,
      },
    });

    if (!attempt) {
      return Response.json(
        { error: "Interview attempt not found" },
        { status: 404 }
      );
    }

    const firstPlannedQuestion = await prisma.interview_questions.findFirst({
      where: {
        interview_id: attempt.interview_id,
      },
      orderBy: {
        question_order: "asc",
      },
      select: {
        question_id: true,
        questions: {
          select: {
            question_text: true,
          },
        },
      },
    });

    const createdQuestion = await prisma.session_questions.create({
      data: {
        attempt_id: attemptId,
        question_id: firstPlannedQuestion?.question_id ?? null,
        content: firstPlannedQuestion?.questions.question_text || fallbackContent,
        source: fallbackSource,
      },
    });

    console.log(
      `[session/question] fallback:create ${Date.now() - fallbackStartedAt}ms total=${Date.now() - startedAt}ms`
    );

    return Response.json({
      ...createdQuestion,
      question_kind: createdQuestion.question_id ? "core" : "follow_up",
      question_order: 1,
    } satisfies SessionQuestionRow);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create session question";

    console.log(
      `[session/question] error after ${Date.now() - startedAt}ms: ${message}`
    );

    return Response.json({ error: message }, { status: 500 });
  }
}
