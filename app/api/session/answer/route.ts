import {
  assertAnswerContextMatches,
  generateAnswer,
  getLogicalQuestionId,
  getSessionQuestionContext,
  type AnswerRecord,
  type JsonValue,
} from "@/app/lib/calmAnswerPipeline";
import { canSubmitAnswer } from "@/app/lib/calmTiming";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RequestBody = {
  sessionQuestionId?: string;
  questionId?: string;
  questionText?: string;
  candidateId?: string;
  attemptId?: string;
  transcript?: string;
  rawTranscript?: string;
  duration?: number;
};

function normalizeTranscript(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function validationStatus(error: Error) {
  if (
    error.message.includes("required") ||
    error.message.includes("does not match") ||
    error.message.includes("not found")
  ) {
    return 400;
  }

  if (
    error.message.includes("Invalid or empty answer") ||
    error.message.includes("relevance validation")
  ) {
    return 422;
  }

  return 500;
}

export async function POST(request: Request) {
  const startedAt = Date.now();

  try {
    console.log("[session/answer] request:start");

    const body = (await request.json()) as RequestBody;
    const sessionQuestionId = body.sessionQuestionId?.trim();
    const transcript = normalizeTranscript(body.transcript ?? "");
    const rawTranscript = normalizeTranscript(body.rawTranscript ?? "");

    if (!sessionQuestionId || !transcript) {
      return Response.json(
        { error: "sessionQuestionId and transcript are required" },
        { status: 400 }
      );
    }

    const context = await getSessionQuestionContext({ sessionQuestionId });

    if (!context) {
      return Response.json(
        { error: "session question not found" },
        { status: 400 }
      );
    }

    assertAnswerContextMatches({
      context,
      attemptId: body.attemptId?.trim(),
      candidateId: body.candidateId?.trim(),
      questionId: body.questionId?.trim(),
    });

    if (
      !canSubmitAnswer(
        { ends_at: context.ends_at },
        { asked_at: context.asked_at }
      )
    ) {
      return Response.json(
        { error: "Answer window has expired" },
        { status: 409 }
      );
    }

    const logicalQuestionId = getLogicalQuestionId(context);
    const answerPayload = {
      original_transcript: rawTranscript || transcript,
      submitted_question_text: body.questionText?.trim() || null,
    } satisfies JsonValue;

    const result = await generateAnswer({
      question_id: logicalQuestionId,
      question_text: context.question_text,
      candidate_id: context.candidate_id,
      attempt_id: context.attempt_id,
      session_question_id: context.session_question_id,
      candidate_answer: transcript,
      duration: body.duration,
      answer_mode: "spoken",
      answer_payload: answerPayload,
    });

    console.log(
      `[session/answer] final-save ${Date.now() - startedAt}ms status=completed`
    );

    return Response.json(result.record satisfies AnswerRecord);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create answer";
    const status = error instanceof Error ? validationStatus(error) : 500;

    console.log(
      `[session/answer] error after ${Date.now() - startedAt}ms: ${message}`
    );

    return Response.json({ error: message }, { status });
  }
}
