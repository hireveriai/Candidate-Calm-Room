import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { CORS_HEADERS, clamp01, createSupabase, jsonResponse } from "../_shared/common.ts";
import { createJsonChatCompletion } from "../_shared/openai.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (request.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  }

  try {
    const { answer_id: answerId } = (await request.json()) as { answer_id?: string };

    if (!answerId?.trim()) {
      return jsonResponse({ success: false, error: "answer_id is required" }, 400);
    }

    const supabase = createSupabase();

    const { data: answer, error: answerError } = await supabase
      .from("interview_answers")
      .select(`
        answer_id,
        answer_text,
        answer_payload,
        session_question_id,
        question_id,
        session_questions (
          session_question_id,
          content,
          source_context,
          mapped_skill_id,
          phase,
          probe_type,
          contradiction_probe
        )
      `)
      .eq("answer_id", answerId.trim())
      .single();

    if (answerError || !answer) {
      return jsonResponse({ success: false, error: "Answer not found" }, 404);
    }

    const sessionQuestion = Array.isArray(answer.session_questions)
      ? answer.session_questions[0]
      : answer.session_questions;

    if (!sessionQuestion?.content || !answer.answer_text) {
      return jsonResponse(
        { success: false, error: "Answer or question content missing" },
        400
      );
    }

    const evaluation = await createJsonChatCompletion(
      [
        {
          role: "system",
          content: [
            "Evaluate a candidate answer for an adaptive AI interview.",
            "Return JSON only with keys:",
            "skill_score, clarity_score, depth_score, confidence_score, fraud_score, reasoning.",
            "All scores must be decimals between 0 and 1.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              question: sessionQuestion.content,
              question_context: sessionQuestion.source_context ?? {},
              mapped_skill_id: sessionQuestion.mapped_skill_id ?? null,
              phase: sessionQuestion.phase ?? null,
              probe_type: sessionQuestion.probe_type ?? null,
              contradiction_probe: sessionQuestion.contradiction_probe ?? false,
              answer: answer.answer_text,
              answer_payload: answer.answer_payload ?? {},
            },
            null,
            2
          ),
        },
      ],
      0.1
    );

    const { data: scoreData, error: scoreError } = await supabase.rpc(
      "record_answer_evaluation",
      {
        p_answer_id: answerId.trim(),
        p_skill_score: clamp01(evaluation.skill_score),
        p_clarity_score: clamp01(evaluation.clarity_score),
        p_depth_score: clamp01(evaluation.depth_score),
        p_confidence_score: clamp01(evaluation.confidence_score),
        p_fraud_score: clamp01(evaluation.fraud_score),
        p_reasoning:
          typeof evaluation.reasoning === "string"
            ? evaluation.reasoning
            : "No reasoning returned",
        p_skill_id: sessionQuestion.mapped_skill_id ?? null,
        p_evaluation_json: evaluation,
      }
    );

    if (scoreError) {
      throw new Error(scoreError.message);
    }

    return jsonResponse({
      success: true,
      data: Array.isArray(scoreData) ? scoreData[0] ?? null : scoreData,
    });
  } catch (error) {
    console.error("[evaluate-answer]", error);
    return jsonResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unexpected error",
      },
      500
    );
  }
});
