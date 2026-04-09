import { finalizeInterviewAttempt } from "@/app/lib/interviewCompletion";
import { prisma } from "@/app/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

type TerminationType =
  | "manual_exit"
  | "tab_close"
  | "disconnect"
  | "timeout";

type RequestBody = {
  attemptId?: string;
  terminationType?: string;
  sessionQuestionId?: string;
  transcript?: string;
  duration?: number;
  currentPhase?: string;
};

type SessionQuestionRow = {
  session_question_id: string;
  attempt_id: string;
  question_id: string | null;
};

async function parseBody(request: Request): Promise<RequestBody> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    return (await request.json()) as RequestBody;
  }

  const raw = await request.text();
  if (!raw.trim()) {
    return {};
  }

  return JSON.parse(raw) as RequestBody;
}

function normalizeTerminationType(value: string | undefined): TerminationType {
  switch (value) {
    case "manual_exit":
    case "tab_close":
    case "disconnect":
    case "timeout":
      return value;
    default:
      return "manual_exit";
  }
}

async function saveInFlightAnswer(params: {
  sessionQuestionId?: string;
  transcript?: string;
  duration?: number;
}) {
  const sessionQuestionId = params.sessionQuestionId?.trim();
  const transcript = params.transcript?.trim();

  if (!sessionQuestionId || !transcript) {
    return;
  }

  const sessionQuestions = await prisma.$queryRaw<SessionQuestionRow[]>`
    select session_question_id, attempt_id, question_id
    from public.session_questions
    where session_question_id = ${sessionQuestionId}::uuid
    limit 1
  `;

  const sessionQuestion = sessionQuestions[0];
  if (!sessionQuestion) {
    return;
  }

  const answerPayload =
    typeof params.duration === "number" && params.duration >= 0
      ? ({ duration: Math.round(params.duration) } satisfies JsonValue)
      : null;

  const existingAnswers = await prisma.$queryRaw<{ answer_id: string }[]>`
    select answer_id
    from public.interview_answers
    where session_question_id = ${sessionQuestionId}::uuid
    limit 1
  `;

  if (existingAnswers[0]?.answer_id) {
    await prisma.$executeRaw`
      update public.interview_answers
      set answer_text = ${transcript}::text,
          answer_payload = ${
            answerPayload ? JSON.stringify(answerPayload) : null
          }::jsonb,
          answered_at = now()
      where answer_id = ${existingAnswers[0].answer_id}::uuid
    `;
    return;
  }

  await prisma.$executeRaw`
    insert into public.interview_answers (
      attempt_id,
      question_id,
      answer_text,
      answer_payload,
      session_question_id
    )
    values (
      ${sessionQuestion.attempt_id}::uuid,
      ${sessionQuestion.question_id ?? null}::uuid,
      ${transcript}::text,
      ${answerPayload ? JSON.stringify(answerPayload) : null}::jsonb,
      ${sessionQuestionId}::uuid
    )
  `;
}

export async function POST(request: Request) {
  try {
    const body = await parseBody(request);
    const attemptId = body.attemptId?.trim();

    if (!attemptId) {
      return Response.json({ error: "attemptId is required" }, { status: 400 });
    }

    await saveInFlightAnswer({
      sessionQuestionId: body.sessionQuestionId,
      transcript: body.transcript,
      duration: body.duration,
    });

    const result = await finalizeInterviewAttempt({
      attemptId,
      earlyExit: true,
      terminationType: normalizeTerminationType(body.terminationType),
      currentPhase: body.currentPhase ?? null,
    });

    return Response.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to terminate interview";

    return Response.json({ error: message }, { status: 500 });
  }
}
