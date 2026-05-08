export const INTERVIEW_STATES = [
  "CREATED",
  "READY",
  "QUESTION_GENERATING",
  "QUESTION_ACTIVE",
  "ANSWER_RECORDING",
  "ANSWER_PROCESSING",
  "FOLLOWUP_GENERATING",
  "COMPLETING",
  "COMPLETED",
  "INTERRUPTED",
  "RECOVERY_ALLOWED",
  "RECOVERY_USED",
  "ABANDONED",
  "FAILED",
  "TIME_EXPIRED",
] as const;

export type InterviewState = (typeof INTERVIEW_STATES)[number];

type LogLevel = "info" | "warn" | "error";

export type InterviewLogContext = {
  interviewId?: string | null;
  attemptId?: string | null;
  orgId?: string | null;
  recruiterId?: string | null;
  candidateId?: string | null;
  questionSequence?: number | null;
  timerState?: Record<string, unknown> | null;
  aiLatencyMs?: number | null;
  prismaFailure?: unknown;
  websocketEvent?: string | null;
  livekitEvent?: string | null;
  state?: string | null;
  nextState?: string | null;
  [key: string]: unknown;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const allowedTransitions: Record<InterviewState, InterviewState[]> = {
  CREATED: ["READY", "QUESTION_GENERATING", "FAILED", "TIME_EXPIRED"],
  READY: ["QUESTION_GENERATING", "QUESTION_ACTIVE", "COMPLETING", "FAILED", "TIME_EXPIRED"],
  QUESTION_GENERATING: ["QUESTION_ACTIVE", "FOLLOWUP_GENERATING", "COMPLETING", "FAILED", "TIME_EXPIRED"],
  QUESTION_ACTIVE: ["ANSWER_RECORDING", "ANSWER_PROCESSING", "QUESTION_GENERATING", "COMPLETING", "FAILED", "TIME_EXPIRED"],
  ANSWER_RECORDING: ["ANSWER_PROCESSING", "COMPLETING", "FAILED", "TIME_EXPIRED"],
  ANSWER_PROCESSING: ["FOLLOWUP_GENERATING", "QUESTION_GENERATING", "QUESTION_ACTIVE", "COMPLETING", "FAILED", "TIME_EXPIRED"],
  FOLLOWUP_GENERATING: ["QUESTION_ACTIVE", "QUESTION_GENERATING", "COMPLETING", "FAILED", "TIME_EXPIRED"],
  COMPLETING: ["COMPLETED", "FAILED", "TIME_EXPIRED"],
  COMPLETED: ["COMPLETED"],
  INTERRUPTED: ["RECOVERY_ALLOWED", "RECOVERY_USED", "ABANDONED", "FAILED"],
  RECOVERY_ALLOWED: ["RECOVERY_USED", "ABANDONED", "FAILED"],
  RECOVERY_USED: ["READY", "QUESTION_GENERATING", "QUESTION_ACTIVE", "COMPLETING", "FAILED", "TIME_EXPIRED"],
  ABANDONED: ["ABANDONED"],
  FAILED: ["READY", "QUESTION_GENERATING", "COMPLETING", "FAILED"],
  TIME_EXPIRED: ["COMPLETING", "COMPLETED", "TIME_EXPIRED"],
};

export function isUuid(value: string | null | undefined): value is string {
  return Boolean(value && uuidPattern.test(String(value).trim()));
}

export function assertUuid(value: string | null | undefined, label: string) {
  if (!isUuid(value)) {
    throw new Error(`Valid ${label} is required`);
  }

  return String(value).trim();
}

export function normalizeInterviewState(value: string | null | undefined): InterviewState {
  const normalized = (value ?? "").trim().toUpperCase();

  if ((INTERVIEW_STATES as readonly string[]).includes(normalized)) {
    return normalized as InterviewState;
  }

  switch ((value ?? "").trim().toLowerCase()) {
    case "started":
    case "active":
      return "QUESTION_ACTIVE";
    case "completed":
    case "ended":
    case "finished":
      return "COMPLETED";
    case "failed":
      return "FAILED";
    default:
      return "CREATED";
  }
}

export function canTransitionInterviewState(
  current: string | null | undefined,
  next: InterviewState
) {
  return allowedTransitions[normalizeInterviewState(current)].includes(next);
}

export function sanitizeStateTransition(
  current: string | null | undefined,
  next: InterviewState
) {
  const normalizedCurrent = normalizeInterviewState(current);

  if (!allowedTransitions[normalizedCurrent].includes(next)) {
    return normalizedCurrent;
  }

  return next;
}

export function logInterviewEvent(
  level: LogLevel,
  event: string,
  context: InterviewLogContext = {}
) {
  const serializedFailure =
    context.prismaFailure instanceof Error
      ? {
          name: context.prismaFailure.name,
          message: context.prismaFailure.message,
          stack: context.prismaFailure.stack,
        }
      : context.prismaFailure ?? null;
  const payload = {
    ...context,
    event,
    at: new Date().toISOString(),
    interviewId: context.interviewId ?? null,
    attemptId: context.attemptId ?? null,
    orgId: context.orgId ?? null,
    recruiterId: context.recruiterId ?? null,
    candidateId: context.candidateId ?? null,
    questionSequence: context.questionSequence ?? null,
    timerState: context.timerState ?? null,
    aiLatencyMs: context.aiLatencyMs ?? null,
    websocketEvent: context.websocketEvent ?? null,
    livekitEvent: context.livekitEvent ?? null,
    state: context.state ?? null,
    nextState: context.nextState ?? null,
    prismaFailure: serializedFailure,
  };

  const line = JSON.stringify(payload);

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function getTimerState(params: {
  startedAt?: Date | string | null;
  endsAt?: Date | string | null;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const startedAt = params.startedAt ? new Date(params.startedAt) : null;
  const endsAt = params.endsAt ? new Date(params.endsAt) : null;
  const elapsedSeconds = startedAt
    ? Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000))
    : 0;
  const remainingSeconds = endsAt
    ? Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / 1000))
    : 0;

  return {
    serverNow: now.toISOString(),
    startedAt: startedAt?.toISOString() ?? null,
    endsAt: endsAt?.toISOString() ?? null,
    elapsedSeconds,
    remainingSeconds,
    expired: Boolean(endsAt && now >= endsAt),
  };
}

export async function retryWithFallback<T>(params: {
  attempts?: number;
  timeoutMs?: number;
  operation: () => Promise<T>;
  fallback: (error: unknown) => T;
  onFailure?: (error: unknown, attempt: number, latencyMs: number) => void;
}) {
  const attempts = Math.max(params.attempts ?? 2, 1);
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const startedAt = Date.now();

    try {
      if (!params.timeoutMs) {
        return await params.operation();
      }

      return await Promise.race([
        params.operation(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("operation timed out")), params.timeoutMs);
        }),
      ]);
    } catch (error) {
      lastError = error;
      params.onFailure?.(error, attempt, Date.now() - startedAt);
    }
  }

  return params.fallback(lastError);
}
