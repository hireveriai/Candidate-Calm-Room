import { prisma } from "@/app/lib/prisma";
import { resolveEffectiveQuestionCount } from "@/app/lib/interviewBudget";

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
  duration_minutes: number | null;
  planned_question_count: number | null;
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

type AnswerSummary = {
  role: string | null;
  skills: string[];
  tools: string[];
  experience: string | null;
  keyPoints: string[];
  cleanedText: string;
};

const SKILL_KEYWORDS = [
  "database administration",
  "database management",
  "performance tuning",
  "query optimization",
  "backup and recovery",
  "incident management",
  "system design",
  "api development",
  "data migration",
  "etl",
  "sql",
  "typescript",
  "node.js",
  "react",
  "python",
];

const TOOL_KEYWORDS = [
  "Oracle",
  "PostgreSQL",
  "MySQL",
  "MongoDB",
  "SQL Server",
  "Linux",
  "AWS",
  "Azure",
  "Docker",
  "Kubernetes",
  "Jira",
];

function hasMissingFunctionError(error: unknown, functionName: string) {
  return (
    error instanceof Error &&
    error.message.includes("Raw query failed") &&
    error.message.includes(functionName) &&
    error.message.includes("does not exist")
  );
}

function hasMissingDatabaseRoutineError(error: unknown) {
  return (
    error instanceof Error &&
    error.message.includes("Raw query failed") &&
    error.message.includes("does not exist") &&
    error.message.includes("function public.")
  );
}

function normalizeText(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanAnswerText(value: string | null | undefined) {
  let cleaned = normalizeText(value);

  if (!cleaned) {
    return "";
  }

  cleaned = cleaned
    .replace(/^(hi|hello|hey)\b[\s,.-]*/i, "")
    .replace(/^(so|well|okay|alright|basically|actually)\b[\s,.-]*/i, "")
    .replace(
      /\b(?:my name is|i am|i'm|this is)\s+[a-z][a-z\s.'-]{1,40}(?:\s*,\s*|\s+and\s+)/i,
      ""
    )
    .replace(
      /\b(?:you know|kind of|sort of|basically|actually|like)\b[\s,]*/gi,
      " "
    );

  return normalizeText(cleaned);
}

function sanitizeRole(value: string | null | undefined) {
  const role = normalizeText(value)
    .replace(/^(an?|the)\s+/i, "")
    .replace(/\b(?:at|with|for)\b.*$/i, "")
    .replace(/[.,"']/g, "")
    .trim();

  if (!role) {
    return null;
  }

  const roleWords = role.split(/\s+/).slice(0, 6);
  const candidateRole = roleWords.join(" ");

  if (!/\b(admin|administrator|engineer|developer|analyst|manager|lead|architect|consultant|specialist|officer)\b/i.test(candidateRole)) {
    return null;
  }

  return candidateRole;
}

function extractRole(answer: string) {
  const patterns = [
    /(?:i work(?:ing)? as|currently work(?:ing)? as|working as|my role is|i serve as|i'm|i am)\s+(?:an?\s+)?([^,.;\n]+?)(?:\s+(?:with|where|focused|handling|responsible|using|on)\b|[,.;\n]|$)/i,
    /(?:current role(?: is)?|position(?: is)?)\s+(?:an?\s+)?([^,.;\n]+?)(?:\s+(?:with|where|focused|handling|responsible|using|on)\b|[,.;\n]|$)/i,
  ];

  for (const pattern of patterns) {
    const match = answer.match(pattern);
    const role = sanitizeRole(match?.[1]);

    if (role) {
      return role;
    }
  }

  return null;
}

function extractExperience(answer: string) {
  const match = answer.match(
    /\b(\d+\+?\s+(?:years?|yrs?)(?:\s+of)?\s+(?:experience|in [a-z][a-z\s/-]+)?)\b/i
  );

  return normalizeText(match?.[1]) || null;
}

function extractKeywordMatches(answer: string, keywords: string[], limit = 3) {
  const matches: string[] = [];

  for (const keyword of keywords) {
    const pattern = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, "i");

    if (pattern.test(answer) && !matches.includes(keyword)) {
      matches.push(keyword);
    }

    if (matches.length >= limit) {
      break;
    }
  }

  return matches;
}

function extractKeyPoints(answer: string) {
  return answer
    .split(/[.!?;]+/)
    .map((part) => normalizeText(part))
    .filter((part) => part.split(/\s+/).length >= 5)
    .slice(0, 2);
}

function summarizeAnswer(answer: string | null | undefined): AnswerSummary {
  const cleanedText = cleanAnswerText(answer);

  return {
    role: extractRole(cleanedText),
    skills: extractKeywordMatches(cleanedText, SKILL_KEYWORDS),
    tools: extractKeywordMatches(cleanedText, TOOL_KEYWORDS),
    experience: extractExperience(cleanedText),
    keyPoints: extractKeyPoints(cleanedText),
    cleanedText,
  };
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
  const summary = summarizeAnswer(lastAnswer);
  const focusSkill = summary.skills[0] ?? summary.tools[0] ?? null;

  if (!summary.cleanedText) {
    return "Can you give one concrete example from your recent work and explain the result?";
  }

  if (summary.role && focusSkill) {
    return `In your role as a ${summary.role}, can you walk me through a recent project where you applied ${focusSkill}?`;
  }

  if (summary.role) {
    return `In your role as a ${summary.role}, can you walk me through a recent project and the outcome?`;
  }

  if (focusSkill) {
    return `Can you walk me through a recent project where you used ${focusSkill} and the result you achieved?`;
  }

  if (summary.experience) {
    return `From your ${summary.experience}, can you share one concrete example of a problem you solved and the result?`;
  }

  return "Can you walk me through one recent project, your responsibilities, and the outcome?";
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
      if (
        !hasMissingFunctionError(error, "public.get_next_interview_question") &&
        !hasMissingDatabaseRoutineError(error)
      ) {
        throw error;
      }

      const attempts = await prisma.$queryRaw<AttemptContextRow[]>`
        select
          ia.interview_id,
          i.question_count,
          i.duration_minutes,
          (
            select count(*)
            from public.interview_questions iq
            where iq.interview_id = ia.interview_id
          )::int as planned_question_count
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
      const totalLimit = resolveEffectiveQuestionCount({
        configuredCount: attempt.question_count,
        durationMinutes: attempt.duration_minutes,
        plannedQuestionCount: attempt.planned_question_count,
      });
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
