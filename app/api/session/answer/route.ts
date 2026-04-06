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
    const rows = await prisma.$queryRaw<AnswerRecord[]>`
      select *
      from public.submit_interview_answer(
        ${sessionQuestionId}::uuid,
        ${transcript}::text,
        ${duration ?? null}::integer
      )
    `;

    console.log(
      `[session/answer] db:submit ${Date.now() - insertStartedAt}ms total=${Date.now() - startedAt}ms`
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
