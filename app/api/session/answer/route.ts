import {
  assertAnswerContextMatches,
  createPendingSpokenAnswer,
  generateAnswer,
  getLogicalQuestionId,
  getSessionQuestionContext,
  getTranscriptCheckpoint,
  type AnswerRecord,
  type JsonValue,
} from "@/app/lib/calmAnswerPipeline";
import { canSubmitAnswer } from "@/app/lib/calmTiming";
import { requireCandidateSession } from "@/app/lib/candidateSession";
import { assertUuid, logInterviewEvent } from "@/app/lib/interviewReliability";
import { repairSpokenTranscript } from "@/app/lib/spokenTranscriptRepair";
import { isInvalidCandidateTranscript } from "@/app/lib/transcriptGuards";
import { mergeMonotonicTranscript } from "@/app/lib/transcriptAccumulator";

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
  allowPendingTranscription?: boolean;
};

function normalizeTranscript(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function isNoResponseSentinel(text: string) {
  return /^no response provided\.?$/i.test(normalizeTranscript(text));
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
    const submittedTranscript = normalizeTranscript(body.transcript ?? "");
    const submittedRawTranscript = normalizeTranscript(body.rawTranscript ?? "");

    if (!sessionQuestionId) {
      return Response.json(
        { error: "sessionQuestionId is required" },
        { status: 400 }
      );
    }

    assertUuid(sessionQuestionId, "sessionQuestionId");

    const context = await getSessionQuestionContext({ sessionQuestionId });

    if (!context) {
      return Response.json(
        { error: "session question not found" },
        { status: 400 }
      );
    }

    const checkpoint = await getTranscriptCheckpoint({
      attemptId: context.attempt_id,
      sessionQuestionId: context.session_question_id,
    });
    const transcript = mergeMonotonicTranscript(
      checkpoint?.transcript,
      submittedTranscript
    );
    const rawTranscript = mergeMonotonicTranscript(
      checkpoint?.transcript,
      submittedRawTranscript || submittedTranscript
    );

    assertAnswerContextMatches({
      context,
      attemptId: body.attemptId?.trim(),
      candidateId: body.candidateId?.trim(),
      questionId: body.questionId?.trim(),
    });
    await requireCandidateSession(request, {
      attemptId: context.attempt_id,
      interviewId: null,
      candidateId: context.candidate_id,
      operation: "session.answer",
    });

    if (
      !canSubmitAnswer(
        { ends_at: context.ends_at },
        { asked_at: context.asked_at },
        { allowFinalGrace: true }
      )
    ) {
      return Response.json(
        { error: "Answer window has expired" },
        { status: 409 }
      );
    }

    const logicalQuestionId = getLogicalQuestionId(context);
    const repairResult = !transcript || isNoResponseSentinel(transcript)
      ? null
      : await repairSpokenTranscript({
          transcript,
          rawTranscript: rawTranscript || transcript,
          questionText: context.question_text,
        });
    const finalTranscript = repairResult?.text ?? transcript;
    const submittedQuestionText = body.questionText?.trim() || null;
    const clarifiedQuestionText =
      submittedQuestionText &&
      submittedQuestionText.replace(/\s+/g, " ").trim().toLowerCase() !==
        context.question_text.replace(/\s+/g, " ").trim().toLowerCase()
        ? submittedQuestionText
        : null;
    const answerPayload = {
      original_transcript: rawTranscript || transcript,
      browser_transcript: transcript,
      repaired_transcript: repairResult?.repaired ? finalTranscript : null,
      transcript_repair: repairResult
        ? {
            repaired: repairResult.repaired,
            reason: repairResult.reason,
            changes: repairResult.changes,
            provider: repairResult.provider ?? null,
            model: repairResult.model ?? null,
          }
        : null,
      original_question_text: context.question_text,
      submitted_question_text: submittedQuestionText,
      clarified_question_text: clarifiedQuestionText,
      transcript_source:
        submittedTranscript && checkpoint
          ? "browser_submission_with_checkpoint"
          : submittedTranscript
            ? "browser_submission"
            : checkpoint
              ? "heartbeat_checkpoint"
              : "missing",
      checkpoint_captured_at: checkpoint?.capturedAt ?? null,
    } satisfies JsonValue;

    const invalidTranscript = isInvalidCandidateTranscript({
      transcript: finalTranscript,
      questionText: context.question_text,
    });

    if (!transcript || isNoResponseSentinel(transcript) || invalidTranscript) {
      // Default to the recording-backed pending path for compatibility with
      // candidates who opened the interview before a deployment. Only a client
      // that explicitly opts into strict capture validation may request a 422.
      if (body.allowPendingTranscription === false) {
        logInterviewEvent("warn", "answer.transcript_capture_required", {
          attemptId: context.attempt_id,
          candidateId: context.candidate_id,
          questionSequence: null,
          aiLatencyMs: Date.now() - startedAt,
          state: "ANSWER_PROCESSING",
          nextState: "LISTENING",
          reason: invalidTranscript
            ? "interviewer_prompt_echo"
            : "browser_speech_recognition_empty",
        });
        return Response.json(
          {
            error: "Your spoken answer was not captured. Please confirm microphone access and repeat the answer before continuing.",
            code: "TRANSCRIPT_CAPTURE_REQUIRED",
          },
          { status: 422 }
        );
      }

      const pendingRecord = await createPendingSpokenAnswer({
        question_id: logicalQuestionId,
        question_text: context.question_text,
        candidate_id: context.candidate_id,
        attempt_id: context.attempt_id,
        session_question_id: context.session_question_id,
        candidate_answer: "",
        duration: body.duration,
        answer_mode: "spoken",
        answer_payload: {
          ...answerPayload,
          original_transcript: rawTranscript || null,
          rejected_transcript: invalidTranscript ? finalTranscript : null,
          transcript_rejected_reason: invalidTranscript
            ? "interviewer_prompt_echo"
            : null,
        },
      });

      logInterviewEvent("info", "answer.transcription_pending", {
        attemptId: context.attempt_id,
        candidateId: context.candidate_id,
        questionSequence: null,
        aiLatencyMs: Date.now() - startedAt,
        state: "ANSWER_PROCESSING",
        nextState: "FOLLOWUP_GENERATING",
        reason: invalidTranscript
          ? "interviewer_prompt_echo"
          : "browser_speech_recognition_empty",
      });

      return Response.json(pendingRecord satisfies AnswerRecord);
    }

    const result = await generateAnswer({
      question_id: logicalQuestionId,
      question_text: context.question_text,
      candidate_id: context.candidate_id,
      attempt_id: context.attempt_id,
      session_question_id: context.session_question_id,
      candidate_answer: finalTranscript,
      duration: body.duration,
      answer_mode: "spoken",
      answer_payload: answerPayload,
      skip_llm: true,
      skip_relevance_validation: true,
    });

    console.log(
      `[session/answer] final-save ${Date.now() - startedAt}ms status=completed`
    );
    logInterviewEvent("info", "answer.completed", {
      attemptId: context.attempt_id,
      candidateId: context.candidate_id,
      questionSequence: null,
      aiLatencyMs: Date.now() - startedAt,
      state: "ANSWER_PROCESSING",
      nextState: "FOLLOWUP_GENERATING",
    });

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
