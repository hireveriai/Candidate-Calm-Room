import { prisma } from "@/app/lib/prisma";
import {
  buildFallbackCoreQuestion,
  buildInterviewBlueprint,
  selectNextCoreQuestion,
} from "@/app/lib/interviewFlow";

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
};

type AttemptInterviewRow = {
  interview_id: string;
  question_count: number | null;
  duration_minutes: number | null;
  experience_level: string | null;
  job_title: string | null;
  planned_question_count: number | null;
};

type PlannedQuestionRow = {
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

type QuestionTypeRow = {
  question_type: string | null;
};

function hasMissingDatabaseColumnError(error: unknown) {
  return (
    error instanceof Error &&
    error.message.includes("Raw query failed") &&
    error.message.toLowerCase().includes("column") &&
    error.message.toLowerCase().includes("does not exist")
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

    const fallbackStartedAt = Date.now();
    const existingQuestions = await prisma.$queryRaw<ExistingSessionQuestionRow[]>`
      select
        session_question_id,
        question_id,
        content,
        source,
        asked_at,
        question_kind
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
        question_order: 1,
        question_type: questionTypes[0]?.question_type ?? null,
      } satisfies SessionQuestionRow);
    }

    const attempts = await prisma.$queryRaw<AttemptInterviewRow[]>`
      select
        ia.interview_id,
        i.question_count,
        i.duration_minutes,
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
    const attempt = attempts[0];

    if (!attempt) {
      return Response.json(
        { error: "Interview attempt not found" },
        { status: 404 }
      );
    }

    let plannedQuestions: PlannedQuestionRow[] = [];

    try {
      plannedQuestions = await prisma.$queryRaw<PlannedQuestionRow[]>`
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
    } catch (error) {
      if (!hasMissingDatabaseColumnError(error)) {
        throw error;
      }

      plannedQuestions = await prisma.$queryRaw<PlannedQuestionRow[]>`
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

    const blueprint = buildInterviewBlueprint({
      configuredCount: attempt.question_count,
      durationMinutes: attempt.duration_minutes,
      plannedQuestionCount: attempt.planned_question_count,
      experienceLevel: attempt.experience_level,
    });

    const firstPlannedQuestion = selectNextCoreQuestion({
      plannedQuestions: plannedQuestions.map((question) => ({
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
      askedQuestions: [],
      blueprint,
      targetDifficulty: 3,
    });

    const createdContent =
      firstPlannedQuestion?.questionText ??
      buildFallbackCoreQuestion({
        sourceType: "resume",
        skillName: plannedQuestions[0]?.skill_name ?? null,
        roleTitle: attempt.job_title,
        phase: "warmup",
      });
    const createdQuestionId = firstPlannedQuestion?.questionId ?? null;
    const createdQuestionType = firstPlannedQuestion?.questionType ?? "open_ended";

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
        ${createdQuestionId}::uuid,
        ${createdContent || fallbackContent}::text,
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
        question_kind
    `;
    const createdQuestion = createdQuestions[0];

    console.log(
      `[session/question] fallback:create ${Date.now() - fallbackStartedAt}ms total=${Date.now() - startedAt}ms`
    );

    return Response.json({
      ...createdQuestion,
      question_kind: createdQuestion.question_kind ?? "core",
      question_order: 1,
      question_type: createdQuestionType,
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
