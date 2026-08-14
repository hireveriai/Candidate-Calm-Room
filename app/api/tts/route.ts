import crypto from "crypto";

import OpenAI from "openai";

import { requireCandidateSession } from "@/app/lib/candidateSession";
import { assertUuid, logInterviewEvent } from "@/app/lib/interviewReliability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Pinned so every candidate, on every device, hears the same VERIS voice -
// and so recordings stop inheriting whatever voice a candidate's OS/browser
// happened to expose to window.speechSynthesis.
const VERIS_VOICE = "shimmer" as const;
const TTS_MODEL = "tts-1" as const; // optimized for latency over tts-1-hd
const MAX_TEXT_LENGTH = 4000;
const CACHE_MAX_ENTRIES = 16;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

type RequestBody = {
  text?: string;
  attemptId?: string;
};

type CacheEntry = {
  bytes: Buffer;
  createdAt: number;
};

// Per-process only. The interview's fixed closing line is spoken at several
// call sites across a session, so this avoids re-billing/re-fetching OpenAI
// for text we've already synthesized recently.
const ttsCache = new Map<string, CacheEntry>();

let openai: OpenAI | null = null;

function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) return null;
  openai ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

function cacheKeyFor(text: string) {
  return crypto.createHash("sha256").update(text.trim().toLowerCase()).digest("hex");
}

function pruneCacheIfNeeded() {
  while (ttsCache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = ttsCache.keys().next().value;
    if (!oldestKey) break;
    ttsCache.delete(oldestKey);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as RequestBody | null;
    const text = body?.text?.trim() ?? "";
    const attemptId = body?.attemptId?.trim() ?? "";

    if (!text) {
      return Response.json({ error: "text is required" }, { status: 400 });
    }

    if (text.length > MAX_TEXT_LENGTH) {
      return Response.json({ error: "text is too long" }, { status: 400 });
    }

    assertUuid(attemptId, "attemptId");
    await requireCandidateSession(request, { attemptId, operation: "tts.speak" });

    const cacheKey = cacheKeyFor(text);
    const cached = ttsCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
      return new Response(new Uint8Array(cached.bytes), {
        headers: {
          "Content-Type": "audio/mpeg",
          "Cache-Control": "no-store",
          "X-Veris-Tts-Cache": "hit",
        },
      });
    }

    const client = getOpenAI();
    if (!client) {
      return Response.json({ error: "TTS is not configured" }, { status: 503 });
    }

    const speechResponse = await client.audio.speech.create({
      model: TTS_MODEL,
      voice: VERIS_VOICE,
      input: text,
      response_format: "mp3",
    });

    const bytes = Buffer.from(await speechResponse.arrayBuffer());

    pruneCacheIfNeeded();
    ttsCache.set(cacheKey, { bytes, createdAt: Date.now() });

    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
        "X-Veris-Tts-Cache": "miss",
      },
    });
  } catch (error) {
    logInterviewEvent("error", "tts.synthesis_failed", { prismaFailure: error });
    const message =
      error instanceof Error ? error.message : "TTS synthesis failed";
    const normalized = message.toLowerCase();
    const status = normalized.includes("session")
      ? 401
      : normalized.includes("required") || normalized.includes("valid")
        ? 400
        : 500;

    return Response.json({ error: message }, { status });
  }
}
