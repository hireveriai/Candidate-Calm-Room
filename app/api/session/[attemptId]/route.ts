import { Prisma } from "@prisma/client";

import { prisma } from "@/app/lib/prisma";

type RouteContext = {
  params: Promise<{
    attemptId: string;
  }>;
};

type InterviewSignalRecord = {
  signal_id: string;
  attempt_id: string;
  type: string;
  value: Prisma.JsonValue;
  created_at: Date | null;
};

type FocusMetricsValue = {
  focusRatio?: number;
  lookAwayEvents?: number;
  maxLookAwayDuration?: number;
  totalAnswerTime?: number;
  assessment?: string;
  sessionQuestionId?: string;
};

function asFocusMetrics(value: Prisma.JsonValue): FocusMetricsValue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as FocusMetricsValue;
}

export async function GET(_: Request, context: RouteContext) {
  try {
    const { attemptId } = await context.params;

    if (!attemptId) {
      return Response.json({ error: "attemptId is required" }, { status: 400 });
    }

    const [sessionQuestions, signals] = await Promise.all([
      prisma.session_questions.findMany({
        where: {
          attempt_id: attemptId,
        },
        select: {
          session_question_id: true,
          content: true,
          source: true,
          asked_at: true,
          interview_answers: {
            select: {
              answer_id: true,
              answer_text: true,
              answer_payload: true,
              answered_at: true,
            },
            orderBy: {
              answered_at: "asc",
            },
          },
        },
        orderBy: {
          asked_at: "asc",
        },
      }),
      prisma.$queryRaw<InterviewSignalRecord[]>(Prisma.sql`
        select signal_id, attempt_id, type, value, created_at
        from interview_signals
        where attempt_id = ${attemptId}::uuid
        order by created_at asc
      `),
    ]);

    const timeline = sessionQuestions.map((item, index) => {
      const nextQuestion = sessionQuestions[index + 1];
      const questionAskedAt = item.asked_at
        ? new Date(item.asked_at).getTime()
        : Number.NEGATIVE_INFINITY;
      const nextQuestionAskedAt = nextQuestion?.asked_at
        ? new Date(nextQuestion.asked_at).getTime()
        : Number.POSITIVE_INFINITY;

      const questionSignals = signals.filter((signal) => {
        const createdAt = signal.created_at
          ? new Date(signal.created_at).getTime()
          : Number.NEGATIVE_INFINITY;

        return createdAt >= questionAskedAt && createdAt < nextQuestionAskedAt;
      });

      const focusSignal = [...questionSignals]
        .reverse()
        .find((signal) => signal.type === "focus_metrics");
      const focusValue = focusSignal ? asFocusMetrics(focusSignal.value) : null;

      return {
        question: {
          session_question_id: item.session_question_id,
          content: item.content,
          source: item.source,
          asked_at: item.asked_at,
        },
        answer: item.interview_answers[0] ?? null,
        signals: questionSignals,
        focusMetrics: focusValue
          ? {
              focusRatio: focusValue.focusRatio ?? null,
              lookAwayEvents: focusValue.lookAwayEvents ?? 0,
              maxLookAwayDuration: focusValue.maxLookAwayDuration ?? 0,
              totalAnswerTime: focusValue.totalAnswerTime ?? null,
              assessment: focusValue.assessment ?? null,
            }
          : null,
      };
    });

    return Response.json({
      attemptId,
      timeline,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch session timeline";

    return Response.json({ error: message }, { status: 500 });
  }
}
