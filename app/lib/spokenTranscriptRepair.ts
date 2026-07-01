export type TranscriptRepairResult = {
  text: string;
  repaired: boolean;
  reason: string;
  changes: string[];
  provider?: string;
  model?: string;
};

function normalizeText(value: string | null | undefined) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function wordCount(value: string) {
  return normalizeText(value).split(/\s+/).filter(Boolean).length;
}

function isSafeRepair(original: string, repaired: string) {
  const originalText = normalizeText(original);
  const repairedText = normalizeText(repaired);

  if (!originalText || !repairedText) {
    return false;
  }

  const originalWords = wordCount(originalText);
  const repairedWords = wordCount(repairedText);
  const lowerOriginal = originalText.toLowerCase();
  const lowerRepaired = repairedText.toLowerCase();

  if (lowerOriginal === lowerRepaired) {
    return true;
  }

  if (originalWords < 6) {
    return false;
  }

  const ratio = repairedWords / Math.max(originalWords, 1);
  if (ratio < 0.72 || ratio > 1.28) {
    return false;
  }

  const originalSet = new Set(lowerOriginal.split(/\W+/).filter((word) => word.length > 2));
  const repairedTokens = lowerRepaired.split(/\W+/).filter((word) => word.length > 2);
  const overlap = repairedTokens.filter((word) => originalSet.has(word)).length;

  return overlap / Math.max(repairedTokens.length, 1) >= 0.58;
}

function parseRepairResponse(content: string) {
  const parsed = JSON.parse(content) as {
    repaired_text?: unknown;
    changes?: unknown;
    reason?: unknown;
  };

  return {
    text: normalizeText(typeof parsed.repaired_text === "string" ? parsed.repaired_text : ""),
    changes: Array.isArray(parsed.changes)
      ? parsed.changes.filter((item): item is string => typeof item === "string").slice(0, 12)
      : [],
    reason: typeof parsed.reason === "string" ? parsed.reason : "stt_repair",
  };
}

export async function repairSpokenTranscript(input: {
  transcript: string;
  rawTranscript?: string | null;
  questionText: string;
}) {
  const transcript = normalizeText(input.transcript);
  const rawTranscript = normalizeText(input.rawTranscript);

  if (!transcript || !process.env.OPENAI_API_KEY || wordCount(transcript) < 6) {
    return {
      text: transcript,
      repaired: false,
      reason: "not_applicable",
      changes: [],
    } satisfies TranscriptRepairResult;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  const model = process.env.TRANSCRIPT_REPAIR_MODEL || "gpt-4o-mini";

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "You repair speech-to-text transcription errors caused by noisy microphones.",
              "Do not improve grammar, vocabulary, fluency, accent, sentence structure, or professionalism.",
              "Keep the candidate's wording style, filler words, incomplete grammar, and meaning.",
              "Only fix words that are very likely misheard by STT using the question context and nearby words.",
              "Do not add facts, tools, numbers, experience, projects, or claims not clearly implied by the transcript.",
              "Return JSON only: {\"repaired_text\":\"...\",\"changes\":[\"heard X -> repaired Y\"],\"reason\":\"...\"}.",
              "If unsure, return the original transcript exactly.",
            ].join("\n"),
          },
          {
            role: "user",
            content: JSON.stringify({
              question: input.questionText,
              transcript,
              raw_transcript: rawTranscript || transcript,
            }),
          },
        ],
      }),
    });

    if (!response.ok) {
      return {
        text: transcript,
        repaired: false,
        reason: `repair_unavailable_${response.status}`,
        changes: [],
        provider: "openai",
        model,
      } satisfies TranscriptRepairResult;
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      return {
        text: transcript,
        repaired: false,
        reason: "empty_repair_response",
        changes: [],
        provider: "openai",
        model,
      } satisfies TranscriptRepairResult;
    }

    const repaired = parseRepairResponse(content);
    if (!isSafeRepair(transcript, repaired.text)) {
      return {
        text: transcript,
        repaired: false,
        reason: "repair_rejected_by_safety_gate",
        changes: repaired.changes,
        provider: "openai",
        model,
      } satisfies TranscriptRepairResult;
    }

    return {
      text: repaired.text,
      repaired: repaired.text.toLowerCase() !== transcript.toLowerCase(),
      reason: repaired.reason,
      changes: repaired.changes,
      provider: "openai",
      model,
    } satisfies TranscriptRepairResult;
  } catch (error) {
    return {
      text: transcript,
      repaired: false,
      reason: error instanceof Error ? error.message : "repair_failed",
      changes: [],
      provider: "openai",
      model,
    } satisfies TranscriptRepairResult;
  } finally {
    clearTimeout(timeout);
  }
}
