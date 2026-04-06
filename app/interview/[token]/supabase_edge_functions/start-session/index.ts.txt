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
    const { token } = (await request.json()) as { token?: string };

    if (!token?.trim()) {
      return jsonResponse({ success: false, error: "token is required" }, 400);
    }

    const supabase = createSupabase();
    const { data, error } = await supabase.rpc("start_interview_session", {
      p_token: token.trim(),
    });

    if (error) {
      throw new Error(error.message);
    }

    return jsonResponse({
      success: true,
      data: Array.isArray(data) ? data[0] ?? null : data,
    });
  } catch (error) {
    console.error("[start-session]", error);
    return jsonResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unexpected error",
      },
      500
    );
  }
});
