import { requireCandidateSession } from "@/app/lib/candidateSession";
import {
  MAX_CLARIFICATIONS_PER_QUESTION,
  buildSafeClarificationFallback,
  sanitizeClarifiedQuestion,
} from "@/app/lib/interviewClarification";
import {
  assertUuid,
  logInterviewEvent,
  retryWithFallback,
} from "@/app/lib/interviewReliability";
import { prisma } from "@/app/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RequestBody = {
  attemptId?: string;
  sessionQuestionId?: string;
  candidateUtterance?: string | null;
  source?: "voice" | "button";
};

type QuestionRow = {
  session_question_id: string;
  attempt_id: string;
  content: string;
  source_context: unknown;
};

type ClarificationSignalRow = {
  value: unknown;
};

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readClarifiedQuestion(value: unknown) {
  const clarified = asRecord(value)?.["clarified_question"];
  return typeof clarified === "string" && clarified.trim()
    ? clarified.trim()
    : null;
}

async function generateClarifiedQuestion(params: {
  originalQuestion: string;
  currentVersion: string;
}) {
  const fallback = buildSafeClarificationFallback(params.currentVersion);

  if (!process.env.OPENAI_API_KEY) {
    return fallback;
  }

  return retryWithFallback<string>({
    attempts: 2,
    timeoutMs: 8000,
    fallback: () => fallback,
    onFailure: (error, attempt, latencyMs) => {
      logInterviewEvent("warn", "ai.question_clarification_failed", {
        attempt,
        aiLatencyMs: latencyMs,
        prismaFailure: error,
      });
    },
    operation: async () => {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: process.env.QUESTION_CLARIFICATION_MODEL || "gpt-4o-mini",
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: [
                "You rephrase interview questions for candidates across every profession and seniority level.",
                "Return JSON with exactly one key: clarified_question.",
                "Restate the same question in plain, concrete language.",
                "You may add neutral context that explains the situation being asked about.",
                "Preserve the original assessment target and scope.",
                "Do not add hints, answer steps, examples of a good answer, expected concepts, evaluation criteria, or an ideal response.",
                "Do not make the question easier in substance; make only the wording easier to understand.",
                "Ask one question, in at most two short sentences.",
              ].join("\n"),
            },
            {
              role: "user",
              content: JSON.stringify({
                original_question: params.originalQuestion,
                version_to_rephrase: params.currentVersion,
              }),
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(
          `Question clarification failed with status ${response.status}`
        );
      }

      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("Question clarification returned an empty response");
      }

      const parsed = JSON.parse(content) as Record<string, unknown>;
      return sanitizeClarifiedQuestion(
        typeof parsed.clarified_question === "string"
          ? parsed.clarified_question
          : null,
        params.currentVersion
      );
    },
  });
}

export async function POST(request: Request) {
  const startedAt = Date.now();

  try {
    const body = (await request.json()) as RequestBody;
    const attemptId = body.attemptId?.trim();
    const sessionQuestionId = body.sessionQuestionId?.trim();
    const source = body.source === "voice" ? "voice" : "button";
    const candidateUtterance = body.candidateUtterance?.trim().slice(0, 500) || null;

    if (!attemptId || !sessionQuestionId) {
      return Response.json(
        { error: "attemptId and sessionQuestionId are required" },
        { status: 400 }
      );
    }

    assertUuid(attemptId, "attemptId");
    assertUuid(sessionQuestionId, "sessionQuestionId");
    await requireCandidateSession(request, {
      attemptId,
      operation: "session.clarify_question",
    });

    const question = (
      await prisma.$queryRaw<QuestionRow[]>`
        select
          session_question_id::text,
          attempt_id::text,
          content,
          source_context
        from public.session_questions
        where session_question_id = ${sessionQuestionId}::uuid
          and attempt_id = ${attemptId}::uuid
        limit 1
      `
    )[0];

    if (!question) {
      return Response.json({ error: "Active question not found" }, { status: 404 });
    }

    const existingSignals = await prisma.$queryRaw<ClarificationSignalRow[]>`
      select value
      from public.interview_signals
      where attempt_id = ${attemptId}::uuid
        and type = 'clarification_requested'
        and value->>'sessionQuestionId' = ${sessionQuestionId}::text
      order by created_at asc, signal_id asc
    `;
    const existingCount = existingSignals.length;

    if (existingCount >= MAX_CLARIFICATIONS_PER_QUESTION) {
      return Response.json(
        {
          error:
            "The clarification limit for this question has been reached. Please answer in your own words or choose Skip.",
          code: "CLARIFICATION_LIMIT_REACHED",
          clarificationCount: existingCount,
          maxClarifications: MAX_CLARIFICATIONS_PER_QUESTION,
        },
        { status: 409 }
      );
    }

    const currentVersion =
      readClarifiedQuestion(existingSignals.at(-1)?.value) ?? question.content;
    const clarifiedQuestion = await generateClarifiedQuestion({
      originalQuestion: question.content,
      currentVersion,
    });

    const persisted = await prisma.$transaction(async (tx: typeof prisma) => {
      await tx.$queryRaw`
        select session_question_id
        from public.session_questions
        where session_question_id = ${sessionQuestionId}::uuid
          and attempt_id = ${attemptId}::uuid
        for update
      `;

      const countRows = await tx.$queryRaw<Array<{ count: number }>>`
        select count(*)::int as count
        from public.interview_signals
        where attempt_id = ${attemptId}::uuid
          and type = 'clarification_requested'
          and value->>'sessionQuestionId' = ${sessionQuestionId}::text
      `;
      const clarificationCount = countRows[0]?.count ?? 0;

      if (clarificationCount >= MAX_CLARIFICATIONS_PER_QUESTION) {
        return null;
      }

      const nextCount = clarificationCount + 1;
      const event = {
        sessionQuestionId,
        original_question: question.content,
        clarified_question: clarifiedQuestion,
        candidate_utterance: candidateUtterance,
        request_source: source,
        clarification_count: nextCount,
        max_clarifications: MAX_CLARIFICATIONS_PER_QUESTION,
        competency_impact: "none",
        severity: "neutral",
      };

      await tx.$executeRaw`
        insert into public.interview_signals (attempt_id, type, value)
        values (
          ${attemptId}::uuid,
          ${"clarification_requested"}::text,
          ${JSON.stringify(event)}::jsonb
        )
      `;

      await tx.$executeRaw`
        update public.session_questions
        set source_context =
          coalesce(source_context, '{}'::jsonb) ||
          jsonb_build_object(
            'original_question', content,
            'clarifications',
            coalesce(source_context->'clarifications', '[]'::jsonb) ||
              jsonb_build_array(${JSON.stringify(event)}::jsonb)
          )
        where session_question_id = ${sessionQuestionId}::uuid
          and attempt_id = ${attemptId}::uuid
      `;

      await tx.$executeRaw`
        update public.interview_attempts
        set last_activity_at = now()
        where attempt_id = ${attemptId}::uuid
      `;

      return nextCount;
    });

    if (persisted === null) {
      return Response.json(
        {
          error:
            "The clarification limit for this question has been reached. Please answer in your own words or choose Skip.",
          code: "CLARIFICATION_LIMIT_REACHED",
          clarificationCount: MAX_CLARIFICATIONS_PER_QUESTION,
          maxClarifications: MAX_CLARIFICATIONS_PER_QUESTION,
        },
        { status: 409 }
      );
    }

    logInterviewEvent("info", "question.clarification_requested", {
      attemptId,
      questionSequence: null,
      aiLatencyMs: Date.now() - startedAt,
      state: "LISTENING",
      nextState: "QUESTION_ACTIVE",
      clarificationCount: persisted,
      source,
    });

    return Response.json({
      message: "Of course. Let me explain it in a simpler way.",
      clarifiedQuestion,
      originalQuestion: question.content,
      clarificationCount: persisted,
      maxClarifications: MAX_CLARIFICATIONS_PER_QUESTION,
      competencyImpact: "none",
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to clarify the question";

    logInterviewEvent("error", "question.clarification_failed", {
      aiLatencyMs: Date.now() - startedAt,
      prismaFailure: error,
    });
    return Response.json({ error: message }, { status: 500 });
  }
}
