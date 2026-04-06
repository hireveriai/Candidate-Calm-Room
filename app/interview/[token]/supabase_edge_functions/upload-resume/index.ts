import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { CORS_HEADERS, asStringArray, createSupabase, jsonResponse, sanitizeFileName } from "../_shared/common.ts";
import { createJsonChatCompletion } from "../_shared/openai.ts";

async function extractTextFromFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

  const cleaned = decoded
    .replace(/\u0000/g, " ")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length >= 200) {
    return cleaned.slice(0, 25000);
  }

  return `Resume file uploaded: ${file.name}. Resume text extraction placeholder used.`;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (request.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  }

  try {
    const formData = await request.formData();
    const interviewId = String(formData.get("interview_id") || "").trim();
    const file = formData.get("file");

    if (!interviewId) {
      return jsonResponse({ success: false, error: "interview_id is required" }, 400);
    }

    if (!(file instanceof File)) {
      return jsonResponse({ success: false, error: "file is required" }, 400);
    }

    const supabase = createSupabase();

    const { data: interview, error: interviewError } = await supabase
      .from("interviews")
      .select("interview_id, candidate_id")
      .eq("interview_id", interviewId)
      .single();

    if (interviewError || !interview) {
      return jsonResponse({ success: false, error: "Interview not found" }, 404);
    }

    const filePath = `resumes/${interviewId}/${Date.now()}-${sanitizeFileName(file.name)}`;

    const { error: uploadError } = await supabase.storage
      .from("resumes")
      .upload(filePath, file, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });

    if (uploadError) {
      throw new Error(`Storage upload failed: ${uploadError.message}`);
    }

    const rawResume = await extractTextFromFile(file);
    const extracted = await createJsonChatCompletion(
      [
        {
          role: "system",
          content:
            "Extract structured data from resume. Return JSON with keys: skills (string array), claims (object), experience_years (number or null).",
        },
        {
          role: "user",
          content: rawResume,
        },
      ],
      0.1
    );

    const { error: insertError } = await supabase.from("candidate_resume_ai").insert({
      interview_id: interviewId,
      raw_resume: rawResume,
      extracted_skills: asStringArray(extracted.skills),
      extracted_claims:
        extracted.claims && typeof extracted.claims === "object"
          ? extracted.claims
          : {},
      claimed_experience_years:
        typeof extracted.experience_years === "number"
          ? extracted.experience_years
          : null,
    });

    if (insertError) {
      throw new Error(`Resume insert failed: ${insertError.message}`);
    }

    if (interview.candidate_id) {
      await supabase
        .from("candidates")
        .update({
          resume_url: filePath,
          resume_text: rawResume,
        })
        .eq("candidate_id", interview.candidate_id);
    }

    return jsonResponse({ success: true });
  } catch (error) {
    console.error("[upload-resume]", error);
    return jsonResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unexpected error",
      },
      500
    );
  }
});
