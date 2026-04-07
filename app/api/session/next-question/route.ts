import { prisma } from "@/app/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RequestBody = {
  attemptId?: string;
  lastQuestion?: string;
  lastAnswer?: string;
};

type NextQuestionRow = {
  session_question_id: string | null;
  question_id: string | null;
  content: string | null;
  source: string | null;
  question_kind: string | null;
  question_order: number | null;
  asked_at: Date | null;
  is_complete: boolean;
  question_type?: string | null;
};

type AskedQuestionRow = {
  session_question_id: string;
  question_id: string | null;
  content: string;
  source: string;
  asked_at: Date | null;
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

function buildFollowUpQuestion(lastAnswer: string | null | undefined) {
  const answer = lastAnswer?.trim();

  if (!answer) {
    return "Can you give one concrete example from your recent work and explain the result?";
  }

  const excerpt = answer.replace(/\s+/g, " ").slice(0, 160);
  const ownershipPattern =
    /\b(led|managed|owned|architected|designed|built|implemented|improved|optimized|migrated|scaled)\b/i;

  if (ownershipPattern.test(excerpt)) {
    return `You mentioned "${excerpt}". What was the hardest decision you made there, and what measurable impact did it have?`;
  }

  return `You mentioned "${excerpt}". Can you walk me through one specific example, your exact role, and the outcome?`;
}

export async function POST(request: Request) {
  const startedAt = Date.now();

  try {
    console.log("[session/next-question] request:start");
    const body = (await request.json()) as RequestBody;
    const { attemptId, lastAnswer } = body;

    if (!attemptId) {
      return Response.json(
        { error: "attemptId is required" },
        { status: 400 }
      );
    }

    const createStartedAt = Date.now();
    let sessionQuestion: NextQuestionRow | undefined;

    try {
      const rows = await prisma.$queryRaw<NextQuestionRow[]>`
        select *
        from public.get_next_interview_question(
          ${attemptId}::uuid,
          ${lastAnswer ?? null}::text
        )
      `;
      sessionQuestion = rows[0];
    } catch (error) {
      if (!hasMissingFunctionError(error, "public.get_next_interview_question")) {
        throw error;
      }

      const attempt = await prisma.interview_attempts.findUnique({
        where: {
          attempt_id: attemptId,
        },
        select: {
          interview_id: true,
          interviews: {
            select: {
              question_count: true,
            },
          },
        },
      });

      if (!attempt) {
        return Response.json(
          { error: "Interview attempt not found" },
          { status: 404 }
        );
      }

      const askedQuestions = (await prisma.session_questions.findMany({
        where: {
          attempt_id: attemptId,
        },
        orderBy: [
          {
            asked_at: "asc",
          },
          {
            session_question_id: "asc",
          },
        ],
      })) as AskedQuestionRow[];

      const latestQuestion = askedQuestions.at(-1) ?? null;
      const totalLimit = attempt.interviews?.question_count ?? 9;
      const askedTotal = askedQuestions.length;
      const askedFollowUps = askedQuestions.filter(
        (question) => !question.question_id
      ).length;
      const requiredFollowUps = Math.min(2, totalLimit);
      const remainingSlots = Math.max(totalLimit - askedTotal, 0);
      const remainingFollowUps = Math.max(requiredFollowUps - askedFollowUps, 0);

      if (remainingSlots <= 0) {
        sessionQuestion = {
          session_question_id: null,
          question_id: null,
          content: null,
          source: null,
          question_kind: null,
          question_order: null,
          asked_at: null,
          is_complete: true,
        };
      } else {
        const latestAnswerRecord = latestQuestion
          ? await prisma.interview_answers.findFirst({
              where: {
                session_question_id: latestQuestion.session_question_id,
              },
              orderBy: {
                answered_at: "desc",
              },
              select: {
                answer_text: true,
              },
            })
          : null;

        const effectiveLastAnswer =
          lastAnswer?.trim() || latestAnswerRecord?.answer_text || "";
        const wordCount = effectiveLastAnswer
          ? effectiveLastAnswer.trim().split(/\s+/).length
          : 0;
        const askedCoreQuestionIds = askedQuestions
          .map((question) => question.question_id)
          .filter((questionId): questionId is string => Boolean(questionId));

        const nextCore = await prisma.interview_questions.findFirst({
          where: {
            interview_id: attempt.interview_id,
            ...(askedCoreQuestionIds.length > 0
              ? {
                  question_id: {
                    notIn: askedCoreQuestionIds,
                  },
                }
              : {}),
          },
          orderBy: {
            question_order: "asc",
          },
          select: {
            question_id: true,
            questions: {
              select: {
                question_text: true,
                question_type: true,
              },
            },
          },
        });

        const shouldAskFollowUp =
          Boolean(latestQuestion?.question_id) &&
          remainingFollowUps > 0 &&
          Boolean(effectiveLastAnswer) &&
          (wordCount >= 25 ||
            remainingSlots <= remainingFollowUps + 1 ||
            !nextCore);

        const createdQuestion = shouldAskFollowUp
          ? await prisma.session_questions.create({
              data: {
                attempt_id: attemptId,
                question_id: null,
                content: buildFollowUpQuestion(effectiveLastAnswer),
                source: "ai",
              },
            })
          : nextCore
            ? await prisma.session_questions.create({
                data: {
                  attempt_id: attemptId,
                  question_id: nextCore.question_id,
                  content: nextCore.questions.question_text,
                  source: "system",
                },
              })
            : remainingFollowUps > 0 && effectiveLastAnswer
              ? await prisma.session_questions.create({
                  data: {
                    attempt_id: attemptId,
                    question_id: null,
                    content: buildFollowUpQuestion(effectiveLastAnswer),
                    source: "ai",
                  },
                })
              : null;

        sessionQuestion = createdQuestion
          ? {
              ...createdQuestion,
              question_kind: createdQuestion.question_id ? "core" : "follow_up",
              question_order: askedTotal + 1,
              is_complete: false,
              question_type: nextCore?.questions.question_type ?? null,
            }
          : {
              session_question_id: null,
              question_id: null,
              content: null,
              source: null,
              question_kind: null,
              question_order: null,
              asked_at: null,
              is_complete: true,
            };
      }
    }

    console.log(
      `[session/next-question] db:get-next ${Date.now() - createStartedAt}ms total=${Date.now() - startedAt}ms`
    );

    if (!sessionQuestion) {
      return Response.json(
        { error: "No next question result returned" },
        { status: 500 }
      );
    }

    if (sessionQuestion.is_complete || !sessionQuestion.session_question_id) {
      await prisma.interview_attempts.updateMany({
        where: {
          attempt_id: attemptId,
        },
        data: {
          status: "completed",
          ended_at: new Date(),
        },
      });

      return Response.json({
        complete: true,
      });
    }

    const questionTypes = sessionQuestion.question_id
      ? await prisma.$queryRaw<QuestionTypeRow[]>`
          select question_type
          from public.questions
          where question_id = ${sessionQuestion.question_id}::uuid
          limit 1
        `
      : [];

    return Response.json({
      complete: false,
      question: sessionQuestion.content,
      session_question_id: sessionQuestion.session_question_id,
      question_kind: sessionQuestion.question_kind,
      question_type:
        sessionQuestion.question_type ?? questionTypes[0]?.question_type ?? null,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create next question";

    console.log(
      `[session/next-question] error after ${Date.now() - startedAt}ms: ${message}`
    );

    return Response.json({ error: message }, { status: 500 });
  }
}
