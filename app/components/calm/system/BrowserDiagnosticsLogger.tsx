"use client";

import { useEffect } from "react";

const MAX_LOGS_PER_SESSION = 50;
const DEDUPE_WINDOW_MS = 10_000;
const MAX_MESSAGE_LENGTH = 2_000;

function serializeArg(arg: unknown): string {
  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack}` : ""}`;
  }
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

export default function BrowserDiagnosticsLogger({
  active,
  attemptId,
}: {
  active: boolean;
  attemptId: string;
}) {
  useEffect(() => {
    if (!active || !attemptId) return;

    let sentCount = 0;
    const lastSentAt: Record<string, number> = {};

    const send = (level: "error" | "warn", message: string, source: string) => {
      if (sentCount >= MAX_LOGS_PER_SESSION) return;

      const truncated = message.slice(0, MAX_MESSAGE_LENGTH);
      const dedupeKey = `${level}:${source}:${truncated}`;
      const now = Date.now();
      if (now - (lastSentAt[dedupeKey] ?? 0) < DEDUPE_WINDOW_MS) return;
      lastSentAt[dedupeKey] = now;
      sentCount += 1;

      void fetch("/api/session/browser-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attemptId,
          level,
          message: truncated,
          source,
        }),
        keepalive: true,
      }).catch(() => {
        // Diagnostic logging must never interrupt the interview.
      });
    };

    const originalError = console.error;
    const originalWarn = console.warn;

    console.error = (...args: unknown[]) => {
      send("error", args.map(serializeArg).join(" "), "console.error");
      originalError.apply(console, args);
    };

    console.warn = (...args: unknown[]) => {
      send("warn", args.map(serializeArg).join(" "), "console.warn");
      originalWarn.apply(console, args);
    };

    const handleWindowError = (event: ErrorEvent) => {
      send(
        "error",
        `${event.message}${event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : ""}`,
        "window.onerror"
      );
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      send("error", serializeArg(event.reason), "unhandledrejection");
    };

    window.addEventListener("error", handleWindowError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);

    return () => {
      console.error = originalError;
      console.warn = originalWarn;
      window.removeEventListener("error", handleWindowError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, [active, attemptId]);

  return null;
}
