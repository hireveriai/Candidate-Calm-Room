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
      attempt_id: attemptId,
      last_answer: lastAnswer,
    } = (await request.json()) as {
      attempt_id?: string;
      last_answer?: string;
    };

    if (!attemptId?.trim()) {
      return jsonResponse({ success: false, error: "attempt_id is required" }, 400);
    }

    const supabase = createSupabase();
    const { data, error } = await supabase.rpc("get_next_interview_question", {
      p_attempt_id: attemptId.trim(),
      p_last_answer: lastAnswer ?? null,
    });

    if (error) {
      throw new Error(error.message);
    }

    return jsonResponse({
      success: true,
      data: Array.isArray(data) ? data[0] ?? null : data,
    });
  } catch (error) {
    console.error("[get-next-question]", error);
    return jsonResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unexpected error",
      },
      500
    );
  }
});
