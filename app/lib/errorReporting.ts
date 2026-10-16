/**
 * Dependency-free server error reporting, wired through instrumentation.ts
 * (Next.js onRequestError). Every unhandled request error is logged as one
 * structured JSON line (searchable in Vercel logs); when SENTRY_DSN is set it is
 * also sent to Sentry's store endpoint. No SDK and no account are needed until
 * a DSN is added.
 *
 * Privacy: only the route pattern (e.g. /interview/[token]) is reported, never
 * the concrete path, query, headers or body — invite tokens live in paths.
 * Same logic in auth, calm-room, recruiter-dashboard and war-room; keep them in sync.
 */
type RequestErrorContext = {
  routePath?: string;
  routeType?: string;
};

type RequestErrorRequest = {
  method?: string;
};

export function parseSentryDsn(dsn: string | undefined | null) {
  if (!dsn) {
    return null;
  }

  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\/+|\/+$/g, "");

    if (!url.username || !projectId || !/^\d+$/.test(projectId)) {
      return null;
    }

    return {
      storeUrl: `${url.protocol}//${url.host}/api/${projectId}/store/`,
      publicKey: url.username,
    };
  } catch {
    return null;
  }
}

export function buildErrorEvent(app: string, error: unknown, request?: RequestErrorRequest, context?: RequestErrorContext) {
  const err = error instanceof Error ? error : new Error(String(error));
  const digest = (error as { digest?: unknown } | null)?.digest;

  return {
    app,
    name: err.name,
    message: err.message.slice(0, 2000),
    stack: err.stack?.slice(0, 8000) ?? null,
    digest: typeof digest === "string" ? digest : null,
    method: request?.method ?? null,
    route: context?.routePath ?? null,
    routeType: context?.routeType ?? null,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || "unknown",
    release: process.env.VERCEL_GIT_COMMIT_SHA || null,
  };
}

export async function reportServerError(app: string, error: unknown, request?: RequestErrorRequest, context?: RequestErrorContext) {
  const event = buildErrorEvent(app, error, request, context);

  console.error(JSON.stringify({ level: "error", event: "server.unhandled_error", at: new Date().toISOString(), ...event, stack: undefined }));

  const sentry = parseSentryDsn(process.env.SENTRY_DSN?.trim());
  if (!sentry) {
    return;
  }

  try {
    await fetch(sentry.storeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${sentry.publicKey}, sentry_client=verisnova-${app}/1.0`,
      },
      body: JSON.stringify({
        event_id: crypto.randomUUID().replace(/-/g, ""),
        timestamp: Date.now() / 1000,
        platform: "node",
        level: "error",
        server_name: app,
        environment: event.environment,
        release: event.release ?? undefined,
        transaction: event.route ?? undefined,
        tags: { app, route_type: event.routeType ?? "unknown", method: event.method ?? "unknown" },
        exception: { values: [{ type: event.name, value: event.message }] },
        extra: { stack: event.stack, digest: event.digest },
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Reporting must never affect the request that failed.
  }
}
