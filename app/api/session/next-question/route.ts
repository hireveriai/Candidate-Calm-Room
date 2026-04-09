import { prisma } from "@/app/lib/prisma";
import {
  buildAskedQuestionState,
  buildFallbackCoreQuestion,
  buildInterviewBlueprint,
  deriveInterviewPhase,
  pickNextExpectedSource,
  selectNextCoreQuestion,
  shouldCompleteInterview,
} from "@/app/lib/interviewFlow";

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
  question_kind: string | null;
  asked_at: Date | null;
};

type QuestionTypeRow = {
  question_type: string | null;
};

type AttemptContextRow = {
  interview_id: string;
  started_at: Date;
  question_count: number | null;
  duration_minutes: number | null;
  planned_question_count: number | null;
  required_follow_up_questions: number | null;
  experience_level: string | null;
  job_title: string | null;
};

type LatestAnswerRow = {
  answer_text: string | null;
};

type NextCoreQuestionRow = {
  question_id: string | null;
  question_text: string;
  question_type: string | null;
  source_type: string | null;
  question_order: number;
  allow_follow_up: boolean | null;
  difficulty_level: number | null;
  phase_hint: string | null;
  target_skill_id: string | null;
  skill_name: string | null;
};

type CreatedSessionQuestionRow = {
  session_question_id: string;
  question_id: string | null;
  content: string;
  source: string;
  question_kind?: string | null;
  asked_at: Date | null;
};

type LatestEvaluationRow = {
  skill_score: string | number | null;
};

type RequiredSkillRow = {
  skill_id: string;
  skill_name: string | null;
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

function hasMissingDatabaseColumnError(error: unknown) {
  return (
    error instanceof Error &&
    error.message.includes("Raw query failed") &&
    error.message.toLowerCase().includes("column") &&
    error.message.toLowerCase().includes("does not exist")
  );
}

function asNumber(value: string | number | null | undefined) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
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

    let attempts: AttemptContextRow[];

    try {
      attempts = await prisma.$queryRaw<AttemptContextRow[]>`
        select
          ia.interview_id,
          ia.started_at,
          i.question_count,
          i.duration_minutes,
          i.required_follow_up_questions,
          jp.experience_level,
          jp.job_title,
          (
            select count(*)
            from public.interview_questions iq
            where iq.interview_id = ia.interview_id
          )::int as planned_question_count
        from public.interview_attempts ia
        join public.interviews i
          on i.interview_id = ia.interview_id
        left join public.job_positions jp
          on jp.job_id = i.job_id
        where ia.attempt_id = ${attemptId}::uuid
        limit 1
      `;
    } catch (error) {
      if (!hasMissingDatabaseColumnError(error)) {
        throw error;
      }

      attempts = await prisma.$queryRaw<AttemptContextRow[]>`
        select
          ia.interview_id,
          ia.started_at,
          i.question_count,
          i.duration_minutes,
          ${null}::int as required_follow_up_questions,
          ${null}::text as experience_level,
          ${null}::text as job_title,
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
    }

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
          question_kind,
          asked_at
        from public.session_questions
        where attempt_id = ${attemptId}::uuid
        order by question_order asc nulls last, asked_at asc nulls last, session_question_id asc
    `;

    const latestQuestion = askedQuestions.at(-1) ?? null;
    const blueprint = buildInterviewBlueprint({
      configuredCount: attempt.question_count,
      durationMinutes: attempt.duration_minutes,
      plannedQuestionCount: attempt.planned_question_count,
      experienceLevel: attempt.experience_level,
    });
    const totalLimit = blueprint.totalQuestions;
    const askedTotal = askedQuestions.length;
    const askedFollowUps = askedQuestions.filter(
      (question: AskedQuestionRow) => question.question_kind === "follow_up"
    ).length;
    const requiredFollowUps = Math.min(
      attempt.required_follow_up_questions ?? 2,
      Math.max(totalLimit - 1, 0)
    );
    const remainingFollowUps = Math.max(requiredFollowUps - askedFollowUps, 0);
    const elapsedSeconds = Math.max(
      0,
      Math.round((Date.now() - new Date(attempt.started_at).getTime()) / 1000)
    );

    let plannedQuestions: NextCoreQuestionRow[] = [];

    try {
      plannedQuestions = await prisma.$queryRaw<NextCoreQuestionRow[]>`
          select
            iq.question_id,
            coalesce(nullif(iq.question_text, ''), q.question_text) as question_text,
            coalesce(iq.question_type, q.question_type) as question_type,
            iq.source_type,
            iq.question_order,
            iq.allow_follow_up,
            iq.difficulty_level,
            iq.phase_hint,
            iq.target_skill_id,
            sm.skill_name
          from public.interview_questions iq
          left join public.questions q
            on q.question_id = iq.question_id
          left join public.skill_master sm
            on sm.skill_id = iq.target_skill_id
          where iq.interview_id = ${attempt.interview_id}::uuid
            and coalesce(nullif(iq.question_text, ''), q.question_text) is not null
          order by iq.question_order asc
      `;
    } catch (plannedQuestionError) {
      if (!hasMissingDatabaseColumnError(plannedQuestionError)) {
        throw plannedQuestionError;
      }

      plannedQuestions = await prisma.$queryRaw<NextCoreQuestionRow[]>`
          select
            iq.question_id,
            q.question_text,
            q.question_type,
            ${null}::text as source_type,
            iq.question_order,
            ${true}::boolean as allow_follow_up,
            q.difficulty_level,
            ${null}::text as phase_hint,
            ${null}::uuid as target_skill_id,
            ${null}::text as skill_name
          from public.interview_questions iq
          join public.questions q
            on q.question_id = iq.question_id
          where iq.interview_id = ${attempt.interview_id}::uuid
          order by iq.question_order asc
      `;
    }

    const requiredSkills = await prisma.$queryRaw<RequiredSkillRow[]>`
        select distinct
          sm.skill_id,
          sm.skill_name
        from public.interview_skill_map ism
        join public.skill_master sm
          on sm.skill_id = ism.skill_id
        where ism.interview_id = ${attempt.interview_id}::uuid
    `;

    const askedState = buildAskedQuestionState({
      askedQuestions: askedQuestions.map((question: AskedQuestionRow) => ({
        questionId: question.question_id,
        content: question.content,
        questionKind: question.question_kind,
      })),
      plannedQuestions: plannedQuestions.map((question: NextCoreQuestionRow) => ({
        questionId: question.question_id,
        questionText: question.question_text,
        questionType: question.question_type,
        sourceType: question.source_type,
        questionOrder: question.question_order,
        allowFollowUp: question.allow_follow_up ?? true,
        difficultyLevel: question.difficulty_level,
        phaseHint: question.phase_hint,
        targetSkillId: question.target_skill_id,
        skillName: question.skill_name,
      })),
      requiredSkills: requiredSkills.map((skill: RequiredSkillRow) => ({
        skillId: skill.skill_id,
        skillName: skill.skill_name,
      })),
    });

    const completion = shouldCompleteInterview({
      askedTotal,
      totalQuestions: totalLimit,
      elapsedSeconds,
      durationMinutes: attempt.duration_minutes,
      requiredSkillIds: requiredSkills.map((skill: RequiredSkillRow) => skill.skill_id),
      coveredSkillIds: askedState.coveredSkillIds,
    });

    if (completion.complete) {
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
      let latestEvaluation: LatestEvaluationRow | null = null;

      if (latestQuestion && latestAnswerRecord?.answer_text) {
        try {
          latestEvaluation = (
            await prisma.$queryRaw<LatestEvaluationRow[]>`
              select iae.skill_score
              from public.interview_answers ia
              join public.interview_answer_evaluations iae
                on iae.answer_id = ia.answer_id
               and iae.evaluator_type = 'AI'
              where ia.session_question_id = ${latestQuestion.session_question_id}::uuid
              order by ia.answered_at desc nulls last
              limit 1
            `
          )[0] ?? null;
        } catch (error) {
          if (!hasMissingDatabaseColumnError(error)) {
            throw error;
          }

          latestEvaluation = (
            await prisma.$queryRaw<LatestEvaluationRow[]>`
              select iae.score as skill_score
              from public.interview_answers ia
              join public.interview_answer_evaluations iae
                on iae.answer_id = ia.answer_id
               and iae.evaluator_type = 'AI'
              where ia.session_question_id = ${latestQuestion.session_question_id}::uuid
              order by ia.answered_at desc nulls last
              limit 1
            `
          )[0] ?? null;
        }
      }

      const effectiveLastAnswer =
        lastAnswer?.trim() || latestAnswerRecord?.answer_text || "";
      const wordCount = effectiveLastAnswer
        ? effectiveLastAnswer.trim().split(/\s+/).length
        : 0;
      const skillScore = asNumber(latestEvaluation?.skill_score);
      const targetDifficulty =
        skillScore >= 0.75 ? 4 : skillScore > 0 && skillScore <= 0.45 ? 2 : 3;
      const nextCore = selectNextCoreQuestion({
        plannedQuestions: plannedQuestions.map((question: NextCoreQuestionRow) => ({
          questionId: question.question_id,
          questionText: question.question_text,
          questionType: question.question_type,
          sourceType: question.source_type,
          questionOrder: question.question_order,
          allowFollowUp: question.allow_follow_up ?? true,
          difficultyLevel: question.difficulty_level,
          phaseHint: question.phase_hint,
          targetSkillId: question.target_skill_id,
          skillName: question.skill_name,
        })),
        askedQuestions: askedQuestions.map((question: AskedQuestionRow) => ({
          questionId: question.question_id,
          content: question.content,
          questionKind: question.question_kind,
        })),
        blueprint,
        targetDifficulty,
      });
      const shouldPreferNextCore =
        Boolean(nextCore) &&
        isExperienceOverviewQuestion(latestQuestion?.content) &&
        answerAlreadyCoversExperienceOverview(effectiveLastAnswer);

      const shouldAskFollowUp =
        latestQuestion?.question_kind === "core" &&
        !shouldPreferNextCore &&
        remainingFollowUps > 0 &&
        Boolean(effectiveLastAnswer) &&
        (wordCount >= 25 ||
          skillScore <= 0.55 ||
          !nextCore);

      let createdQuestion: CreatedSessionQuestionRow | null = null;
      let createdQuestionType: string | null = null;

      if (shouldAskFollowUp) {
        const createdQuestions = await prisma.$queryRaw<CreatedSessionQuestionRow[]>`
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
              ${buildFollowUpQuestion(effectiveLastAnswer)}::text,
              ${"ai"}::text,
              ${"follow_up"}::text,
              ${askedTotal + 1}::integer
            )
            returning
              session_question_id,
              question_id,
              content,
              source,
              asked_at,
              question_kind
          `;
        createdQuestion = createdQuestions[0] ?? null;
        createdQuestionType = "follow_up";
      } else if (nextCore?.questionText) {
        const createdQuestions = await prisma.$queryRaw<CreatedSessionQuestionRow[]>`
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
              ${nextCore.questionId}::uuid,
              ${nextCore.questionText}::text,
              ${"system"}::text,
              ${"core"}::text,
              ${askedTotal + 1}::integer
            )
            returning
              session_question_id,
              question_id,
              content,
              source,
              asked_at,
              question_kind
          `;
        createdQuestion = createdQuestions[0] ?? null;
        createdQuestionType = nextCore.questionType ?? "open_ended";
      } else {
        const nextExpectedSource = pickNextExpectedSource(
          blueprint,
          askedState.usedDistribution
        );
        const uncoveredSkill =
          requiredSkills.find(
            (skill: RequiredSkillRow) => !askedState.coveredSkillIds.has(skill.skill_id)
          ) ??
          null;
        const phase = deriveInterviewPhase({
          askedTotal,
          totalQuestions: totalLimit,
        });
        const createdQuestions = await prisma.$queryRaw<CreatedSessionQuestionRow[]>`
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
              ${buildFallbackCoreQuestion({
                sourceType: nextExpectedSource,
                skillName: uncoveredSkill?.skill_name ?? plannedQuestions[0]?.skill_name ?? null,
                roleTitle: attempt.job_title,
                phase,
              })}::text,
              ${"system"}::text,
              ${"core"}::text,
              ${askedTotal + 1}::integer
            )
            returning
              session_question_id,
              question_id,
              content,
              source,
              asked_at,
              question_kind
          `;
        createdQuestion = createdQuestions[0] ?? null;
        createdQuestionType =
          nextExpectedSource === "behavioral" ? "behavioral" : "open_ended";
      }

      if (!createdQuestion && remainingFollowUps > 0 && effectiveLastAnswer) {
        const createdQuestions = await prisma.$queryRaw<CreatedSessionQuestionRow[]>`
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
              ${buildFollowUpQuestion(effectiveLastAnswer)}::text,
              ${"ai"}::text,
              ${"follow_up"}::text,
              ${askedTotal + 1}::integer
            )
            returning
              session_question_id,
              question_id,
              content,
              source,
              asked_at,
              question_kind
          `;
        createdQuestion = createdQuestions[0] ?? null;
        createdQuestionType = "follow_up";
      }

      sessionQuestion = createdQuestion
        ? {
            ...createdQuestion,
            question_kind: createdQuestion.question_kind ?? "core",
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
