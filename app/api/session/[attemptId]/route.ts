import { prisma } from "@/app/lib/prisma";
import {
  RecruiterAccessError,
  requireRecruiterAttemptAccess,
} from "@/app/lib/recruiterSession";
import { createRecordingSignedUrl } from "@/app/lib/recordingStorage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

type RouteContext = {
  params: Promise<{
    attemptId: string;
  }>;
};

type InterviewSignalRecord = {
  signal_id: string;
  attempt_id: string;
  type: string;
  value: JsonValue;
  created_at: Date | null;
};

type InterviewAnswerSummary = {
  answer_id: string;
  answer_text: string;
  answer_payload: JsonValue | null;
  answered_at: Date | null;
};

type SessionQuestionSummary = {
  session_question_id: string;
  content: string;
  source: string;
  asked_at: Date | null;
  interview_answers: InterviewAnswerSummary[];
};

type RecordingSummary = {
  recording_id: string;
  status: string | null;
  file_path: string | null;
  started_at: Date | null;
  ended_at: Date | null;
};

type FocusMetricsValue = {
  focusRatio?: number;
  lookAwayEvents?: number;
  maxLookAwayDuration?: number;
  totalAnswerTime?: number;
  assessment?: string;
  sessionQuestionId?: string;
};

function asFocusMetrics(value: JsonValue): FocusMetricsValue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as FocusMetricsValue;
}

function getRecordingOffsetMs(value: JsonValue) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const offset = value.recordingOffsetMs;
  return typeof offset === "number" && Number.isFinite(offset)
    ? Math.max(0, Math.round(offset))
    : null;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { attemptId } = await context.params;

    if (!attemptId) {
      return Response.json({ error: "attemptId is required" }, { status: 400 });
    }

    await requireRecruiterAttemptAccess(request, attemptId);

    const [sessionQuestions, signals, recordings] = await Promise.all([
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
      }) as Promise<SessionQuestionSummary[]>,
      prisma.$queryRaw<InterviewSignalRecord[]>`
        select signal_id, attempt_id, type, value, created_at
        from interview_signals
        where attempt_id = ${attemptId}::uuid
        order by created_at asc
      `,
      prisma.$queryRaw<RecordingSummary[]>`
        select recording_id::text, status, file_path, started_at, ended_at
        from public.interview_recordings
        where attempt_id = ${attemptId}::uuid
          and status = 'completed'
        order by started_at asc
        limit 1
      `,
    ]);
    const recordingStartedAt = recordings[0]?.started_at
      ? new Date(recordings[0].started_at).getTime()
      : null;
    const recording = recordings[0];
    const signedRecording =
      recording?.file_path
        ? await createRecordingSignedUrl(recording.file_path)
        : null;

    const timeline = sessionQuestions.map((item: SessionQuestionSummary, index: number) => {
      const nextQuestion = sessionQuestions[index + 1];
      const questionAskedAt = item.asked_at
        ? new Date(item.asked_at).getTime()
        : Number.NEGATIVE_INFINITY;
      const nextQuestionAskedAt = nextQuestion?.asked_at
        ? new Date(nextQuestion.asked_at).getTime()
        : Number.POSITIVE_INFINITY;

      const questionSignals = signals.filter((signal: InterviewSignalRecord) => {
        const createdAt = signal.created_at
          ? new Date(signal.created_at).getTime()
          : Number.NEGATIVE_INFINITY;

        return createdAt >= questionAskedAt && createdAt < nextQuestionAskedAt;
      });

      const focusSignal = [...questionSignals]
        .reverse()
        .find((signal: InterviewSignalRecord) => signal.type === "focus_metrics");
      const focusValue = focusSignal ? asFocusMetrics(focusSignal.value) : null;

      return {
        question: {
          session_question_id: item.session_question_id,
          content: item.content,
          source: item.source,
          asked_at: item.asked_at,
        },
        answer: item.interview_answers[0] ?? null,
        signals: questionSignals.map((signal: InterviewSignalRecord) => ({
          ...signal,
          recording_offset_ms:
            recordingStartedAt !== null && signal.created_at
              ? Math.max(
                  0,
                  new Date(signal.created_at).getTime() - recordingStartedAt,
                )
              : getRecordingOffsetMs(signal.value),
        })),
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
      recording: recording
        ? {
            recording_id: recording.recording_id,
            status: recording.status,
            started_at: recording.started_at,
            ended_at: recording.ended_at,
            playback_url: signedRecording?.url ?? null,
            playback_url_expires_at: signedRecording?.expiresAt ?? null,
            playback_url_expires_in: signedRecording?.expiresIn ?? null,
          }
        : null,
    });
  } catch (error) {
    if (error instanceof RecruiterAccessError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    const message =
      error instanceof Error ? error.message : "Failed to fetch session timeline";

    return Response.json({ error: message }, { status: 500 });
  }
}
