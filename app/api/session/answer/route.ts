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

function hasMissingFunctionError(error: unknown, functionName: string) {
  return (
    error instanceof Error &&
    error.message.includes("Raw query failed") &&
    error.message.includes(functionName) &&
    error.message.includes("does not exist")
  );
}

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
    let answer: AnswerRecord | undefined;

    try {
      const rows = await prisma.$queryRaw<AnswerRecord[]>`
        select *
        from public.submit_interview_answer(
          ${sessionQuestionId}::uuid,
          ${transcript}::text,
          ${duration ?? null}::integer
        )
      `;
      answer = rows[0];
    } catch (error) {
      if (!hasMissingFunctionError(error, "public.submit_interview_answer")) {
        throw error;
      }

      const sessionQuestion = await prisma.session_questions.findUnique({
        where: {
          session_question_id: sessionQuestionId,
        },
        select: {
          session_question_id: true,
          attempt_id: true,
          question_id: true,
        },
      });

      if (!sessionQuestion) {
        return Response.json(
          { error: "session question not found" },
          { status: 400 }
        );
      }

      const answerPayload =
        duration === undefined ? null : ({ duration } satisfies JsonValue);

      const existingAnswer = await prisma.interview_answers.findFirst({
        where: {
          session_question_id: sessionQuestionId,
        },
      });

      answer = existingAnswer
        ? ((await prisma.interview_answers.update({
            where: {
              answer_id: existingAnswer.answer_id,
            },
            data: {
              answer_text: transcript,
              answer_payload: answerPayload,
              answered_at: new Date(),
            },
          })) as AnswerRecord)
        : ((await prisma.interview_answers.create({
            data: {
              attempt_id: sessionQuestion.attempt_id,
              question_id: sessionQuestion.question_id,
              session_question_id: sessionQuestion.session_question_id,
              answer_text: transcript,
              answer_payload: answerPayload,
            },
          })) as AnswerRecord);
    }

    console.log(
      `[session/answer] db:submit ${Date.now() - insertStartedAt}ms total=${Date.now() - startedAt}ms`
    );

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
