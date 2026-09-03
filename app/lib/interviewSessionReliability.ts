export const HEARTBEAT_INTERVAL_MS = 25_000;
export const HEARTBEAT_TIMEOUT_MS = 12_000;
export const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
export const MAX_RECONNECT_ATTEMPTS = RECONNECT_BACKOFF_MS.length;
export const RECONNECT_GRACE_WINDOW_SECONDS = 180;
export const STALE_ATTEMPT_THRESHOLD_SECONDS = 300;
export const SESSION_END_BUFFER_SECONDS = 600;
// Each disconnect episode is capped at MAX_RECONNECT_ATTEMPTS consecutive
// retries client-side, but nothing previously capped the total NUMBER of
// episodes across a session -- a connection that briefly recovers just long
// enough to reset the heartbeat clock each time can flap indefinitely
// without ever looking "stale" to the watchdog. This is a session-wide
// backstop: once a session has racked up this many disconnect episodes, its
// connection is unrecoverable and the watchdog should close it immediately
// rather than waiting for the heartbeat to go quiet.
export const MAX_SESSION_RECONNECT_EVENTS = 20;

export const SESSION_FINAL_STATUSES = [
  "COMPLETED",
  "TERMINATED",
  "ABANDONED",
  "EXPIRED",
  "FAILED",
  "FINALIZED",
  "TIME_EXPIRED",
] as const;

export const ACTIVE_SESSION_STATUSES = [
  "STARTED",
  "IN_PROGRESS",
  "RECONNECTING",
  "QUESTION_ACTIVE",
  "ANSWER_RECORDING",
  "ANSWER_PROCESSING",
  "FOLLOWUP_GENERATING",
  "READY",
  "QUESTION_GENERATING",
  "RECOVERY_USED",
  "CREATED",
] as const;

export type FinalSessionStatus = (typeof SESSION_FINAL_STATUSES)[number];
export type ActiveSessionStatus = (typeof ACTIVE_SESSION_STATUSES)[number];
export type SessionTerminationType =
  | "completed"
  | "manual_exit"
  | "browser_close"
  | "disconnect"
  | "timeout"
  | "watchdog_timeout"
  | "network_disconnect_timeout";

export type ReconnectEventRecord = {
  type:
    | "disconnect_detected"
    | "reconnect_attempt"
    | "reconnect_succeeded"
    | "reconnect_failed"
    | "heartbeat_failed"
    | "media_recovered";
  at: string;
  latency_ms?: number | null;
  reason?: string | null;
  attempt?: number | null;
  source?: string | null;
  metadata?: Record<string, unknown> | null;
};

export function normalizeAttemptStatus(value: string | null | undefined) {
  return (value ?? "").trim().toUpperCase();
}

export function isFinalSessionStatus(value: string | null | undefined) {
  const normalized = normalizeAttemptStatus(value);
  return SESSION_FINAL_STATUSES.includes(
    normalized as FinalSessionStatus
  );
}

export function isReconnectLikeStatus(value: string | null | undefined) {
  return normalizeAttemptStatus(value) === "RECONNECTING";
}

/** Browser page lifecycle events are audit signals until a real failure is confirmed. */
export function isProvisionalPageLifecycleSource(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase() === "browser_pagehide";
}

/**
 * Media tracks and realtime rooms are intentionally stopped while the final
 * answer and recording are being committed. Those shutdown events must not
 * downgrade a successfully answered interview to interrupted.
 */
export function shouldSuppressReliabilityInterruption(params: {
  completionInFlight: boolean;
  interviewFinished?: boolean;
}) {
  return params.completionInFlight || params.interviewFinished === true;
}

export function mapCompletionStatus(params: {
  earlyExit: boolean;
  terminationType: string | null | undefined;
}) {
  if (!params.earlyExit) {
    return {
      status: "COMPLETED" as const,
      terminationType: "completed" as const,
    };
  }

  switch ((params.terminationType ?? "").trim().toLowerCase()) {
    case "manual_exit":
      return {
        status: "ABANDONED" as const,
        terminationType: "manual_exit" as const,
      };
    case "tab_close":
      return {
        status: "ABANDONED" as const,
        terminationType: "browser_close" as const,
      };
    case "timeout":
      return {
        status: "TIME_EXPIRED" as const,
        terminationType: "timeout" as const,
      };
    case "watchdog_timeout":
      return {
        status: "ABANDONED" as const,
        terminationType: "watchdog_timeout" as const,
      };
    case "network_disconnect_timeout":
      return {
        status: "ABANDONED" as const,
        terminationType: "network_disconnect_timeout" as const,
      };
    case "disconnect":
    default:
      return {
        status: "ABANDONED" as const,
        terminationType: "disconnect" as const,
      };
  }
}

/**
 * The parent interview row is what recruiters see. It must be derived from the
 * attempt's real outcome, never asserted.
 *
 * An attempt that was ABANDONED, timed out, exited early, or whose transcripts
 * could not be repaired is NOT a completed interview, and stamping it
 * COMPLETED/FINALIZED hides a platform-side failure behind a status that reads
 * as a candidate result. `final_status` keeps the precise machine reason so the
 * admin console and analytics lose no detail.
 */
export function mapInterviewOutcome(params: {
  attemptStatus: string | null | undefined;
  earlyExit: boolean;
  transcriptStatus?: string | null;
}) {
  const attemptStatus = normalizeAttemptStatus(params.attemptStatus);
  const transcriptStatus = normalizeAttemptStatus(params.transcriptStatus);
  const transcriptIncomplete = transcriptStatus === "PARTIAL";

  if (attemptStatus === "TIME_EXPIRED") {
    return { status: "NEEDS_REVIEW" as const, finalStatus: "TIME_EXPIRED" };
  }

  if (attemptStatus === "ABANDONED") {
    return { status: "NEEDS_REVIEW" as const, finalStatus: "ABANDONED" };
  }

  if (attemptStatus === "FAILED" || attemptStatus === "TERMINATED") {
    return { status: "NEEDS_REVIEW" as const, finalStatus: attemptStatus };
  }

  if (transcriptIncomplete) {
    return {
      status: "NEEDS_REVIEW" as const,
      finalStatus: "TRANSCRIPT_REVIEW_REQUIRED",
    };
  }

  if (params.earlyExit) {
    return { status: "NEEDS_REVIEW" as const, finalStatus: "EARLY_EXIT" };
  }

  return { status: "COMPLETED" as const, finalStatus: "FINALIZED" };
}
