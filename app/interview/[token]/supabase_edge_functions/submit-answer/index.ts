import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { CORS_HEADERS, createSupabase, jsonResponse } from "../_shared/common.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (request.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  }

  try {
    const {
      session_question_id: sessionQuestionId,
      transcript,
      duration_seconds: durationSeconds,
      signals,
    } = (await request.json()) as {
      session_question_id?: string;
      transcript?: string;
      duration_seconds?: number;
      signals?: Record<string, unknown>;
    };

    if (!sessionQuestionId?.trim()) {
      return jsonResponse({ success: false, error: "session_question_id is required" }, 400);
    }

    const supabase = createSupabase();
    const { data, error } = await supabase.rpc("submit_interview_answer", {
      p_session_question_id: sessionQuestionId.trim(),
      p_transcript: transcript ?? null,
      p_duration_seconds:
        typeof durationSeconds === "number" ? Math.max(0, Math.round(durationSeconds)) : null,
      p_signals: signals ?? null,
    });

    if (error) {
      throw new Error(error.message);
    }

    return jsonResponse({
      success: true,
      data: Array.isArray(data) ? data[0] ?? null : data,
    });
  } catch (error) {
    console.error("[submit-answer]", error);
    return jsonResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unexpected error",
      },
      500
    );
  }
});
