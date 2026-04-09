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

type AttemptContextRow = {
  interview_id: string;
  question_count: number | null;
};

type LatestAnswerRow = {
  answer_text: string | null;
};

type NextCoreQuestionRow = {
  question_id: string;
  question_text: string;
  question_type: string | null;
};

type CreatedSessionQuestionRow = {
  session_question_id: string;
  question_id: string | null;
  content: string;
  source: string;
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

function normalizeText(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function isExperienceOverviewQuestion(question: string | null | undefined) {
  const normalized = normalizeText(question).toLowerCase();

  return (
    normalized.includes("tell me about your experience") ||
    normalized.includes("tell me about yourself") ||
    normalized.includes("walk me through your background") ||
    normalized.includes("work most relevant to this role") ||
    normalized.includes("roles and responsibilities") ||
    normalized.includes("role and responsibilities") ||
    normalized.includes("current role")
  );
}

function answerAlreadyCoversExperienceOverview(answer: string | null | undefined) {
  const normalized = normalizeText(answer);

  if (!normalized) {
    return false;
  }

  const wordCount = normalized.split(/\s+/).length;
  const mentionsRole =
    /\b(currently|working as|my role|responsib|experience|years?|senior|lead|engineer|administrator|developer|analyst|manager)\b/i.test(
      normalized
    );
  const technologyMatches =
    normalized.match(
      /\b(sql|oracle|postgres|postgresql|mysql|database|dba|linux|aws|azure|etl|jira|mongodb|python|java|node|typescript|react)\b/gi
    )?.length ?? 0;

  return wordCount >= 35 && mentionsRole && technologyMatches >= 1;
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

  return `You mentioned "${excerpt}". Can you walk me through one recent project where you applied those skills and the outcome you achieved?`;
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

      const attempts = await prisma.$queryRaw<AttemptContextRow[]>`
        select
          ia.interview_id,
          i.question_count
        from public.interview_attempts ia
        join public.interviews i
          on i.interview_id = ia.interview_id
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

      const askedQuestions = await prisma.$queryRaw<AskedQuestionRow[]>`
        select
          session_question_id,
          question_id,
          content,
          source,
          asked_at
        from public.session_questions
        where attempt_id = ${attemptId}::uuid
        order by asked_at asc nulls last, session_question_id asc
      `;

      const latestQuestion = askedQuestions.at(-1) ?? null;
      const totalLimit = attempt.question_count ?? 9;
      const askedTotal = askedQuestions.length;
      const askedFollowUps = askedQuestions.filter(
        (question: AskedQuestionRow) => !question.question_id
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
          ? (
              await prisma.$queryRaw<LatestAnswerRow[]>`
                select answer_text
                from public.interview_answers
                where session_question_id = ${latestQuestion.session_question_id}::uuid
                order by answered_at desc nulls last
                limit 1
              `
            )[0]
          : null;

        const effectiveLastAnswer =
          lastAnswer?.trim() || latestAnswerRecord?.answer_text || "";
        const wordCount = effectiveLastAnswer
          ? effectiveLastAnswer.trim().split(/\s+/).length
          : 0;

        const nextCores = await prisma.$queryRaw<NextCoreQuestionRow[]>`
          select
            iq.question_id,
            q.question_text,
            q.question_type
          from public.interview_questions iq
          join public.questions q
            on q.question_id = iq.question_id
          where iq.interview_id = ${attempt.interview_id}::uuid
            and not exists (
              select 1
              from public.session_questions sq
              where sq.attempt_id = ${attemptId}::uuid
                and sq.question_id = iq.question_id
            )
          order by iq.question_order asc
          limit 1
        `;
        const nextCore = nextCores[0];
        const shouldPreferNextCore =
          Boolean(nextCore) &&
          isExperienceOverviewQuestion(latestQuestion?.content) &&
          answerAlreadyCoversExperienceOverview(effectiveLastAnswer);

        const shouldAskFollowUp =
          Boolean(latestQuestion?.question_id) &&
          !shouldPreferNextCore &&
          remainingFollowUps > 0 &&
          Boolean(effectiveLastAnswer) &&
          (wordCount >= 25 ||
            remainingSlots <= remainingFollowUps + 1 ||
            !nextCore);

        let createdQuestion: CreatedSessionQuestionRow | null = null;
        let createdQuestionType: string | null = null;

        if (shouldAskFollowUp) {
          const createdQuestions = await prisma.$queryRaw<CreatedSessionQuestionRow[]>`
            insert into public.session_questions (
              attempt_id,
              question_id,
              content,
              source
            )
            values (
              ${attemptId}::uuid,
              ${null}::uuid,
              ${buildFollowUpQuestion(effectiveLastAnswer)}::text,
              ${"ai"}::text
            )
            returning
              session_question_id,
              question_id,
              content,
              source,
              asked_at
          `;
          createdQuestion = createdQuestions[0] ?? null;
        } else if (nextCore) {
          const createdQuestions = await prisma.$queryRaw<CreatedSessionQuestionRow[]>`
            insert into public.session_questions (
              attempt_id,
              question_id,
              content,
              source
            )
            values (
              ${attemptId}::uuid,
              ${nextCore.question_id}::uuid,
              ${nextCore.question_text}::text,
              ${"system"}::text
            )
            returning
              session_question_id,
              question_id,
              content,
              source,
              asked_at
          `;
          createdQuestion = createdQuestions[0] ?? null;
          createdQuestionType = nextCore.question_type ?? null;
        } else if (remainingFollowUps > 0 && effectiveLastAnswer) {
          const createdQuestions = await prisma.$queryRaw<CreatedSessionQuestionRow[]>`
            insert into public.session_questions (
              attempt_id,
              question_id,
              content,
              source
            )
            values (
              ${attemptId}::uuid,
              ${null}::uuid,
              ${buildFollowUpQuestion(effectiveLastAnswer)}::text,
              ${"ai"}::text
            )
            returning
              session_question_id,
              question_id,
              content,
              source,
              asked_at
          `;
          createdQuestion = createdQuestions[0] ?? null;
        }

        sessionQuestion = createdQuestion
          ? {
              ...createdQuestion,
              question_kind: createdQuestion.question_id ? "core" : "follow_up",
              question_order: askedTotal + 1,
              is_complete: false,
              question_type: createdQuestionType,
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
