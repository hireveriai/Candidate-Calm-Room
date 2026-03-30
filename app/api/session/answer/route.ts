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

type RequestBody = {
  sessionQuestionId?: string;
  transcript?: string;
  duration?: number;
};

type AnswerRecord = {
  answer_id: string;
  attempt_id: string;
  question_id: string | null;
  session_question_id: string | null;
  answer_text: string;
  answer_payload: JsonValue | null;
  answered_at: Date | null;
};

export async function POST(request: Request) {
  const startedAt = Date.now();

  try {
    console.log("[session/answer] request:start");
    const body = (await request.json()) as RequestBody;
    const { sessionQuestionId, transcript, duration } = body;

    if (!sessionQuestionId || !transcript) {
      return Response.json(
        { error: "sessionQuestionId and transcript are required" },
        { status: 400 }
      );
    }

    const insertStartedAt = Date.now();
    const answerPayload =
      duration === undefined ? null : JSON.stringify({ duration });

    const rows = await prisma.$queryRaw<AnswerRecord[]>`
      insert into interview_answers (
        attempt_id,
        question_id,
        session_question_id,
        answer_text,
        answer_payload
      )
      select
        sq.attempt_id,
        sq.question_id,
        sq.session_question_id,
        ${transcript},
        ${answerPayload}::jsonb
      from session_questions sq
      where sq.session_question_id = ${sessionQuestionId}::uuid
      returning
        answer_id,
        attempt_id,
        question_id,
        session_question_id,
        answer_text,
        answer_payload,
        answered_at
    `;

    console.log(
      `[session/answer] db:insert-returning ${Date.now() - insertStartedAt}ms total=${Date.now() - startedAt}ms`
    );

    const answer = rows[0];

    if (!answer) {
      return Response.json(
        { error: "session question not found" },
        { status: 400 }
      );
    }

    return Response.json(answer);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create answer";

    console.log(`[session/answer] error after ${Date.now() - startedAt}ms: ${message}`);

    return Response.json({ error: message }, { status: 500 });
  }
}
