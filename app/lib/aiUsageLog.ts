import { prisma } from "@/app/lib/prisma";

// Every OpenAI call in this app funnels its billing metadata through here so
// `public.ai_audit_logs` answers "which feature spent the money", not just
// "the account spent money". The OpenAI dashboard aggregates per key, and one
// key is shared by calm-room, both dashboards, admin, and local development -
// so the provider side alone cannot attribute a bill to a feature.

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AiTokenUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens_details?: Record<string, unknown>;
  completion_tokens_details?: Record<string, unknown>;
  input_tokens_details?: Record<string, unknown>;
  output_tokens_details?: Record<string, unknown>;
};

// Audio endpoints bill by characters or seconds and return no `usage` block,
// so the caller reports the billable quantity it already knows.
export type AiBillingUnits = {
  characters?: number;
  audio_seconds?: number;
  images?: number;
};

export type AiUsageEntry = {
  /** Dot-separated feature path, e.g. "interview.answer_evaluation". */
  operation: string;
  model: string;
  entityType?: string | null;
  entityId?: string | null;
  endpoint?: string | null;
  status?: number | null;
  ok?: boolean;
  latencyMs?: number | null;
  usage?: AiTokenUsage | null;
  billing?: AiBillingUnits | null;
  error?: unknown;
  meta?: Record<string, unknown> | null;
};

function normalizeEntityId(entityId: string | null | undefined) {
  const trimmed = entityId?.trim();
  return trimmed && UUID_PATTERN.test(trimmed) ? trimmed : null;
}

function normalizeError(error: unknown) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

async function insertUsageRow(entry: AiUsageEntry) {
  const requestPayload = {
    app: "calm-room",
    operation: entry.operation,
    model: entry.model,
    ...(entry.endpoint ? { endpoint: entry.endpoint } : {}),
    ...(entry.meta ?? {}),
  };

  const responsePayload = {
    ...(entry.usage ? { usage: entry.usage } : {}),
    ...(entry.billing ? { billing: entry.billing } : {}),
    ...(typeof entry.status === "number" ? { status: entry.status } : {}),
    ...(typeof entry.ok === "boolean" ? { ok: entry.ok } : {}),
    ...(typeof entry.latencyMs === "number"
      ? { latency_ms: Math.round(entry.latencyMs) }
      : {}),
    ...(entry.error ? { error: normalizeError(entry.error) } : {}),
  };

  await prisma.$executeRaw`
    insert into public.ai_audit_logs (
      entity_type,
      entity_id,
      ai_provider,
      request_payload,
      response_payload
    ) values (
      ${entry.entityType ?? entry.operation.split(".")[0] ?? null},
      ${normalizeEntityId(entry.entityId)}::uuid,
      'openai',
      ${JSON.stringify(requestPayload)}::jsonb,
      ${JSON.stringify(responsePayload)}::jsonb
    )
  `;
}

/**
 * Records one OpenAI call. Never throws and never blocks the caller's result:
 * cost telemetry must not be able to fail an interview. Inside a request the
 * insert is deferred past the response via `after()`; in scripts and
 * background jobs, where there is no request context, it runs inline.
 */
export function logAiUsage(entry: AiUsageEntry) {
  const write = () =>
    insertUsageRow(entry).catch((error) => {
      console.warn("ai usage logging failed", {
        operation: entry.operation,
        error: normalizeError(error),
      });
    });

  try {
    // Required lazily rather than imported: the repair and backfill scripts
    // pull this module in through recordingTranscriptRepair and run outside
    // Next entirely, so `next/server` must not be a load-time dependency.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { after } = require("next/server") as {
      after?: (task: () => unknown) => void;
    };

    if (typeof after === "function") {
      after(write);
      return;
    }
  } catch {
    // Falls through to the inline write below.
  }

  void write();
}

export type OpenAiFetchMeta = Omit<
  AiUsageEntry,
  "usage" | "status" | "ok" | "latencyMs" | "error" | "model"
> & {
  /** Falls back to the `model` field of the request body when omitted. */
  model?: string;
};

/**
 * Drop-in replacement for `fetch` against the OpenAI REST API that records the
 * `usage` block every completion returns. The body is buffered and re-wrapped,
 * so callers can still use `response.ok` and `await response.json()` exactly as
 * before. No call site in this app streams, so buffering is safe.
 *
 * The attribution metadata rides inside the init object as `aiUsage` so that
 * adopting this at a call site is a two-line diff - `fetch` becomes
 * `openAiFetch`, plus one property - with no re-indentation of the body.
 */
export async function openAiFetch(
  url: string,
  init: RequestInit & { aiUsage: OpenAiFetchMeta }
) {
  const { aiUsage: meta, ...requestInit } = init;
  const startedAt = Date.now();
  let requestedModel = meta.model ?? "unknown";

  if (!meta.model && typeof requestInit.body === "string") {
    try {
      requestedModel = JSON.parse(requestInit.body)?.model ?? "unknown";
    } catch {
      // Leaves the model as "unknown" rather than failing the call.
    }
  }

  let response: Response;

  try {
    response = await fetch(url, requestInit);
  } catch (error) {
    logAiUsage({
      ...meta,
      model: requestedModel,
      endpoint: meta.endpoint ?? url,
      ok: false,
      latencyMs: Date.now() - startedAt,
      error,
    });
    throw error;
  }

  const latencyMs = Date.now() - startedAt;
  const bodyText = await response.text();
  let usage: AiTokenUsage | null = null;
  let responseModel: string | null = null;

  try {
    const parsed = JSON.parse(bodyText);
    usage = parsed?.usage ?? null;
    responseModel = typeof parsed?.model === "string" ? parsed.model : null;
  } catch {
    // Non-JSON error bodies still get logged, just without a usage block.
  }

  logAiUsage({
    ...meta,
    model: responseModel ?? requestedModel,
    endpoint: meta.endpoint ?? url,
    status: response.status,
    ok: response.ok,
    latencyMs,
    usage,
    ...(response.ok ? {} : { error: bodyText.slice(0, 500) }),
  });

  return new Response(bodyText, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
