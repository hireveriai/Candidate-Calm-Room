import { prisma } from "@/app/lib/prisma";
import { canAskNextQuestion } from "@/app/lib/calmTiming";
import { requireCandidateSession } from "@/app/lib/candidateSession";
import { assertUuid, logInterviewEvent } from "@/app/lib/interviewReliability";
import {
  classifyInterviewQuestion,
  normalizeInterviewQuestionType,
} from "@/app/lib/interviewQuestionTypes";

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
  question_kind?: string | null;
  question_order?: number | null;
};

type AttemptInterviewRow = {
  interview_id: string;
  ends_at: Date | null;
};

type QuestionTypeRow = {
  question_type: string | null;
};

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

    assertUuid(attemptId, "attemptId");
    await requireCandidateSession(request, {
      attemptId,
      operation: "session.question",
    });

    const fallbackStartedAt = Date.now();
    const existingQuestions = await prisma.$queryRaw<ExistingSessionQuestionRow[]>`
      select
        session_question_id,
        question_id,
        content,
        source,
        asked_at,
        question_kind,
        question_order
      from public.session_questions
      where attempt_id = ${attemptId}::uuid
      order by question_order desc nulls last, asked_at desc nulls last, session_question_id desc
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
        question_kind: existingQuestion.question_kind ?? "core",
        question_order: existingQuestion.question_order ?? 1,
        question_type: normalizeInterviewQuestionType(
          questionTypes[0]?.question_type,
          classifyInterviewQuestion(existingQuestion.content ?? "").questionType
        ),
      } satisfies SessionQuestionRow);
    }

    const attempts = await prisma.$queryRaw<AttemptInterviewRow[]>`
      select ia.interview_id, ia.ends_at
      from public.interview_attempts ia
      where ia.attempt_id = ${attemptId}::uuid
      limit 1
    `;
    const attempt = attempts[0];

    if (!attempt) {
      return Response.json(
        { error: "Interview attempt not found" },
        { status: 404 }
      );
    }

    if (!canAskNextQuestion({ ends_at: attempt.ends_at })) {
      return Response.json(
        {
          error: "Session time has ended. Finish your current answer.",
          complete: true,
        },
        { status: 409 }
      );
    }

    const openingQuestion =
      fallbackContent || "Tell me about your experience and the work most relevant to this role.";
    const createdQuestionType = classifyInterviewQuestion(openingQuestion).questionType;

    const createdQuestions = await prisma.$queryRaw<ExistingSessionQuestionRow[]>`
      insert into public.session_questions (
        attempt_id,
        question_id,
        content,
        source,
        question_kind,
        question_order
      )
      values (
        ${attemptId}::uuid,
        ${null}::uuid,
        ${openingQuestion}::text,
        ${fallbackSource}::text,
        ${"core"}::text,
        ${1}::integer
      )
      returning
        session_question_id,
        question_id,
        content,
        source,
        asked_at,
        question_kind,
        question_order
    `;
    const createdQuestion = createdQuestions[0];

    await prisma.$executeRaw`
      update public.interview_attempts
      set current_phase = ${"warmup"}::text
      where attempt_id = ${attemptId}::uuid
        and upper(coalesce(status, '')) not in ('COMPLETED', 'FINALIZED')
    `;

    console.log(
      `[session/question] fallback:create ${Date.now() - fallbackStartedAt}ms total=${Date.now() - startedAt}ms`
    );
    logInterviewEvent("info", "question.initial_ready", {
      attemptId,
      interviewId: attempt.interview_id,
      questionSequence: createdQuestion.question_order ?? 1,
      aiLatencyMs: Date.now() - fallbackStartedAt,
      state: "QUESTION_GENERATING",
      nextState: "QUESTION_ACTIVE",
      timerState: { endsAt: attempt.ends_at },
    });

    return Response.json({
      ...createdQuestion,
      question_kind: createdQuestion.question_kind ?? "core",
      question_order: 1,
      question_type: normalizeInterviewQuestionType(createdQuestionType),
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
