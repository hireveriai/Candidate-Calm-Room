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
  question_type: string | null;
};

type ExistingSessionQuestionRow = {
  session_question_id: string;
  question_id: string | null;
  content: string;
  source: string;
  asked_at: Date | null;
};

type AttemptInterviewRow = {
  interview_id: string;
};

type PlannedQuestionRow = {
  question_id: string;
  question_text: string;
  question_type: string | null;
};

type QuestionTypeRow = {
  question_type: string | null;
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
        const questionTypes = sessionQuestion.question_id
          ? await prisma.$queryRaw<QuestionTypeRow[]>`
              select question_type
              from public.questions
              where question_id = ${sessionQuestion.question_id}::uuid
              limit 1
            `
          : [];

        return Response.json({
          ...sessionQuestion,
          question_type: questionTypes[0]?.question_type ?? null,
        } satisfies SessionQuestionRow);
      }
    } catch (error) {
      if (!hasMissingFunctionError(error, "public.get_first_interview_question")) {
        throw error;
      }
    }

    const fallbackStartedAt = Date.now();
    const existingQuestions = await prisma.$queryRaw<ExistingSessionQuestionRow[]>`
      select
        session_question_id,
        question_id,
        content,
        source,
        asked_at
      from public.session_questions
      where attempt_id = ${attemptId}::uuid
      order by asked_at desc nulls last, session_question_id desc
      limit 1
    `;
    const existingQuestion = existingQuestions[0];

    if (existingQuestion) {
      const questionTypes = existingQuestion.question_id
        ? await prisma.$queryRaw<QuestionTypeRow[]>`
            select question_type
            from public.questions
            where question_id = ${existingQuestion.question_id}::uuid
            limit 1
          `
        : [];

      return Response.json({
        ...existingQuestion,
        question_kind: existingQuestion.question_id ? "core" : "follow_up",
        question_order: 1,
        question_type: questionTypes[0]?.question_type ?? null,
      } satisfies SessionQuestionRow);
    }

    const attempts = await prisma.$queryRaw<AttemptInterviewRow[]>`
      select interview_id
      from public.interview_attempts
      where attempt_id = ${attemptId}::uuid
      limit 1
    `;
    const attempt = attempts[0];

    if (!attempt) {
      return Response.json(
        { error: "Interview attempt not found" },
        { status: 404 }
      );
    }

    const plannedQuestions = await prisma.$queryRaw<PlannedQuestionRow[]>`
      select
        iq.question_id,
        q.question_text,
        q.question_type
      from public.interview_questions iq
      join public.questions q
        on q.question_id = iq.question_id
      where iq.interview_id = ${attempt.interview_id}::uuid
      order by iq.question_order asc
      limit 1
    `;
    const firstPlannedQuestion = plannedQuestions[0];

    const createdQuestions = await prisma.$queryRaw<ExistingSessionQuestionRow[]>`
      insert into public.session_questions (
        attempt_id,
        question_id,
        content,
        source
      )
      values (
        ${attemptId}::uuid,
        ${firstPlannedQuestion?.question_id ?? null}::uuid,
        ${firstPlannedQuestion?.question_text ?? fallbackContent}::text,
        ${fallbackSource}::text
      )
      returning
        session_question_id,
        question_id,
        content,
        source,
        asked_at
    `;
    const createdQuestion = createdQuestions[0];

    console.log(
      `[session/question] fallback:create ${Date.now() - fallbackStartedAt}ms total=${Date.now() - startedAt}ms`
    );

    return Response.json({
      ...createdQuestion,
      question_kind: createdQuestion.question_id ? "core" : "follow_up",
      question_order: 1,
      question_type: firstPlannedQuestion?.question_type ?? null,
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
