"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";

import CalmLayout from "@/app/components/calm/core/CalmLayout";
import CalmHeader from "@/app/components/calm/core/CalmHeader";
import VideoPanel from "@/app/components/calm/core/VideoPanel";
import QuestionRenderer from "@/app/components/calm/core/QuestionRenderer";
import SystemIndicators from "@/app/components/calm/core/SystemIndicators";
import InterviewControls from "@/app/components/calm/core/InterviewControls";
import PrecheckScreen from "@/app/components/calm/flow/PrecheckScreen";
import ExitModal from "@/app/components/calm/flow/ExitModal";
import InterviewEntryGate from "@/components/interview/InterviewEntryGate";

import WarningOverlay from "@/app/components/calm/system/WarningOverlay";
import AmbientMic from "@/app/components/calm/system/AmbientMic";
import ReconnectOverlay from "./ReconnectOverlay";

import {
  speak,
  startRecognition,
  stopRecognition,
  type VerisSpeechRecognition,
} from "@/app/services/verisVoice";

import useCognitiveSignals from "@/app/hooks/useCognitiveSignals";
import useEventTimeline from "@/app/hooks/useEventTimeline";

import {
  calculateFraudScore,
  classifyRisk,
} from "@/app/utils/fraudEngine";
import {
  classifyInterviewQuestion,
  InterviewQuestionType,
  normalizeInterviewQuestionType,
} from "@/app/lib/interviewQuestionTypes";
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_BACKOFF_MS,
} from "@/app/lib/interviewSessionReliability";
import { isInvalidCandidateTranscript } from "@/app/lib/transcriptGuards";

type VerisState = "idle" | "listening" | "thinking" | "speaking";
type TerminationType =
  | "manual_exit"
  | "tab_close"
  | "disconnect"
  | "timeout"
  | "network_disconnect_timeout";

type TerminationPayload = {
  attemptId: string;
  terminationType: TerminationType;
  currentPhase?: string;
};

type CompletionPayload = {
  attemptId: string;
  currentPhase?: string;
};

type TerminationResult = {
  score: number;
  risk_level: "LOW" | "MEDIUM" | "HIGH";
  strengths: string[];
  weaknesses: string[];
  behavioral_flags: string[];
  recommendation:
    | "STRONG_HIRE"
    | "HIRE"
    | "HOLD"
    | "WEAK_CANDIDATE"
    | "NO_HIRE"
    | "REVIEW_REQUIRED"
    | "RISK";
  reason: string;
  completed: true;
  early_exit: true;
  completion_percentage: number;
  reliability_score: number;
  termination_type: TerminationType;
};

type FocusMetrics = {
  focusRatio: number;
  lookAwayEvents: number;
  maxLookAwayDuration: number;
  totalAnswerTime: number;
  assessment: string;
};

type BehaviorSignalPayload = {
  type: string;
  severity?: "low" | "medium" | "high";
  meta?: unknown;
  timestamp: number;
};

type RecordingSignal = {
  id: string;
  type: string;
  label: string;
  severity: "low" | "medium" | "high";
  occurredAt: number;
  recordingOffsetMs: number;
};

const RECORDING_SIGNAL_LABELS: Record<string, string> = {
  attention_loss: "Attention shifted",
  long_gaze_away: "Extended gaze away",
  multi_face: "Multiple people detected",
  no_face: "Candidate left frame",
  tab_switch: "Tab switch detected",
  unresponsive: "Extended response pause",
};

const CodeEditorModal = dynamic(
  () => import("@/app/components/calm/core/CodeEditorModal"),
  { ssr: false }
);

const VerisOrb = dynamic(
  () => import("@/app/components/calm/core/VerisOrb"),
  { ssr: false }
);

const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const DISCONNECT_GRACE_MS = 15 * 1000;
const MAX_ANSWER_TIME_MS = 3 * 60 * 1000;
const RECORDING_STARTUP_WAIT_MS = 7000;
const STRICT_TAB_TERMINATION = false;
const FINAL_VERIS_CLOSING_LINE =
  "Thank you for your time. Your interview is now complete.";
const FINAL_COMPLETION_MESSAGE =
  "Thank you for your time. Your responses have been recorded. You may now close this window.";
const PENDING_TERMINATION_STORAGE_KEY = "hireveri.pendingTermination";
const PENDING_COMPLETION_STORAGE_KEY = "hireveri.pendingCompletion";
const PENDING_RECOVERY_EVENT_STORAGE_KEY = "hireveri.pendingRecoveryEvent";
const SPEECH_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
  sampleRate: 48000,
  sampleSize: 16,
};

function cleanTranscript(text: string) {
  const collapsed = text.replace(/\s+/g, " ").trim();

  const repeatedSentence = /(.{15,}?[.!?])(?:\s+\1)+/gi;
  const withoutRepeatedSentences = collapsed.replace(repeatedSentence, "$1");

  const repeatedPhrase = /\b([\w']+(?:\s+[\w']+){2,6})\s+\1\b/gi;
  const withoutRepeatedPhrases = withoutRepeatedSentences.replace(
    repeatedPhrase,
    "$1"
  );

  return withoutRepeatedPhrases;
}

function roundMetric(value: number, digits = 2) {
  return Number(value.toFixed(digits));
}

function extractFirstName(fullName: string | null | undefined) {
  const trimmed = (fullName ?? "").trim();
  if (!trimmed) {
    return "";
  }

  return trimmed.split(/\s+/)[0] ?? "";
}

function isDatabaseCapacityError(error: unknown) {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";

  return /EMAXCONNSESSION|max clients reached|pool_size/i.test(message);
}

function getCurrentPhaseFromState(
  verisState: VerisState,
  showCoding: boolean
): string {
  if (showCoding) {
    return "probe";
  }

  if (verisState === "speaking") {
    return "warmup";
  }

  if (verisState === "thinking") {
    return "core";
  }

  if (verisState === "listening") {
    return "core";
  }

  return "core";
}

export default function Page() {
  const params = useParams<{ token: string }>();
  const inviteToken = typeof params?.token === "string" ? params.token : "";
  const [candidateName, setCandidateName] = useState("");
  const [entryReady, setEntryReady] = useState(false);

  const [started, setStarted] = useState(false);
  const [interviewFinished, setInterviewFinished] = useState(false);
  const [interviewInterrupted, setInterviewInterrupted] = useState(false);
  const [completionMessage, setCompletionMessage] = useState(
    "Interview complete. Thank you for your time."
  );
  const [showExit, setShowExit] = useState(false);
  const [exitEnding, setExitEnding] = useState(false);

  const [verisState, setVerisState] = useState<VerisState>("idle");
  const [currentQuestion, setCurrentQuestion] = useState("");
  const [sessionQuestionId, setSessionQuestionId] = useState("");
  const [questionId, setQuestionId] = useState("");
  const [transcript, setTranscript] = useState("");
  const [recordingSignal, setRecordingSignal] =
    useState<RecordingSignal | null>(null);
  const [timeLeft, setTimeLeft] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [attemptId, setAttemptId] = useState("");
  const [interviewId, setInterviewId] = useState("");
  const [candidateId, setCandidateId] = useState("");
  const [currentQuestionType, setCurrentQuestionType] =
    useState<InterviewQuestionType>(InterviewQuestionType.TECHNICAL_DISCUSSION);
  const [sessionEndsAt, setSessionEndsAt] = useState<number | null>(null);
  const [sessionTimeEnded, setSessionTimeEnded] = useState(false);
  const [answerWindowEnded, setAnswerWindowEnded] = useState(false);

  const [audioLevel, setAudioLevel] = useState(0);

  const recognitionRef = useRef<VerisSpeechRecognition | null>(null);
  const silenceTimer = useRef<any>(null);
  const timerRef = useRef<any>(null);
  const questionTimeoutRef = useRef<any>(null);
  const inactivityTimeoutRef = useRef<any>(null);
  const disconnectTimeoutRef = useRef<any>(null);
  const interviewStartTimeRef = useRef<number | null>(null);
  const recordingStartedAtRef = useRef<number | null>(null);
  const recordingFinalizerRef = useRef<(() => Promise<void>) | null>(null);
  const serverClockOffsetMsRef = useRef(0);
  const questionStartTimeRef = useRef<number | null>(null);
  const focusTimeMsRef = useRef(0);
  const focusTotalMsRef = useRef(0);
  const focusSampleAtRef = useRef<number | null>(null);
  const isLookingRef = useRef(true);
  const lookAwayStartRef = useRef<number | null>(null);
  const lookAwayEventsRef = useRef(0);
  const maxLookAwayMsRef = useRef(0);
  const exitIntentRef = useRef(false);
  const currentQuestionRef = useRef("");
  const transcriptRef = useRef("");
  const listeningActiveRef = useRef(false);
  const acceptingTranscriptRef = useRef(false);
  const isAdvancingRef = useRef(false);
  const handleAutoNextRef = useRef<((options?: { allowPendingTranscription?: boolean }) => Promise<void>) | null>(null);
  const terminationInFlightRef = useRef(false);
  const completionInFlightRef = useRef(false);
  const lastSignalSentRef = useRef<Record<string, number>>({});
  const lastSignalPayloadRef = useRef<Record<string, string>>({});
  const recordingSignalTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const lastWarRoomSyncAtRef = useRef<string | null>(null);

  const videoRef = useRef<any>(null);

  const audioStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  const { faceCount, faceDetected, multiFace, attention } =
    useCognitiveSignals({ videoRef, enabled: started });

  const { events, addEvent } = useEventTimeline();

  const [warning, setWarning] = useState({
    type: "soft" as "soft" | "hard",
    message: "",
    visible: false,
  });

  const [, setTabViolations] = useState(0);
  const [showCoding, setShowCoding] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [reconnectReason, setReconnectReason] = useState("");
  const [reconnectCountdownMs, setReconnectCountdownMs] = useState(0);
  const [networkOnline, setNetworkOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine
  );
  const [cameraReady, setCameraReady] = useState(true);
  const [microphoneReady, setMicrophoneReady] = useState(true);
  const [mediaRecoveryError, setMediaRecoveryError] = useState("");
  const [videoReconnectKey, setVideoReconnectKey] = useState(0);

  const heartbeatIntervalRef = useRef<number | null>(null);
  const heartbeatTimeoutRef = useRef<number | null>(null);
  const consecutiveHeartbeatFailuresRef = useRef(0);
  const reconnectTimeoutHandleRef = useRef<number | null>(null);
  const reconnectCountdownIntervalRef = useRef<number | null>(null);
  const reconnectInFlightRef = useRef(false);
  const reconnectPauseStartedAtRef = useRef<number | null>(null);
  const reconnectCurrentAttemptRef = useRef(0);
  const pausedPhaseRef = useRef<VerisState>("idle");
  const shouldResumeListeningRef = useRef(false);
  const shouldResumeAudioAnalysisRef = useRef(false);
  const reconnectRequestIdRef = useRef(
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `session-${Date.now()}`
  );

  useEffect(() => {
    return () => {
      if (recordingSignalTimeoutRef.current) {
        clearTimeout(recordingSignalTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const firstName = extractFirstName(candidateName);

    document.title = firstName
      ? `${firstName} • Interview Session | HireVeri`
      : "Interview Session • HireVeri";
  }, [candidateName, interviewFinished, started, verisState]);

  const persistPendingTermination = (payload: TerminationPayload) => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(
      PENDING_TERMINATION_STORAGE_KEY,
      JSON.stringify(payload)
    );
  };

  const clearPendingTermination = () => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.removeItem(PENDING_TERMINATION_STORAGE_KEY);
  };

  const persistPendingCompletion = (payload: CompletionPayload) => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(
      PENDING_COMPLETION_STORAGE_KEY,
      JSON.stringify(payload)
    );
  };

  const clearPendingCompletion = () => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.removeItem(PENDING_COMPLETION_STORAGE_KEY);
  };

  const persistPendingRecoveryEvent = (payload: unknown) => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(
      PENDING_RECOVERY_EVENT_STORAGE_KEY,
      JSON.stringify(payload)
    );
  };

  const clearPendingRecoveryEvent = () => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.removeItem(PENDING_RECOVERY_EVENT_STORAGE_KEY);
  };

  const postJson = async <T,>(path: string, body: unknown): Promise<T> => {
    const url =
      typeof window === "undefined"
        ? path
        : new URL(path, window.location.origin).toString();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 20_000);

      try {
        const response = await fetch(url, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });

        const contentType = response.headers.get("content-type") || "";
        const payload = contentType.includes("application/json")
          ? await response.json()
          : { error: await response.text() };

        if (!response.ok) {
          throw new Error(payload.error || "Request failed");
        }

        return payload as T;
      } catch (error) {
        if (attempt === 1) {
          if (error instanceof DOMException && error.name === "AbortError") {
            throw new Error(
              "VERIS took too long to prepare the next step. Please try again. Your recorded response is safe."
            );
          }

          throw error;
        }

        await new Promise((resolve) => setTimeout(resolve, 750));
      } finally {
        window.clearTimeout(timeout);
      }
    }

    throw new Error("Request failed");
  };

  const waitForRecordingStartup = async (
    timeoutMs = RECORDING_STARTUP_WAIT_MS
  ) => {
    if (recordingStartedAtRef.current) {
      return true;
    }

    const startedAt = Date.now();

    return new Promise<boolean>((resolve) => {
      const check = () => {
        if (recordingStartedAtRef.current) {
          resolve(true);
          return;
        }

        if (Date.now() - startedAt >= timeoutMs) {
          resolve(false);
          return;
        }

        window.setTimeout(check, 100);
      };

      check();
    });
  };

  const getTerminationPayload = (
    terminationType: TerminationType
  ): TerminationPayload | null => {
    if (!attemptId) {
      return null;
    }

    return {
      attemptId,
      terminationType,
      currentPhase: getCurrentPhaseFromState(verisState, showCoding),
    };
  };

  const postTerminationPayload = async (
    payload: TerminationPayload
  ): Promise<TerminationResult> => {
    const url =
      typeof window === "undefined"
        ? "/api/session/terminate"
        : new URL("/api/session/terminate", window.location.origin).toString();

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      keepalive: true,
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Failed to terminate interview");
    }

    return data as TerminationResult;
  };

  const postCompletionPayload = async (payload: CompletionPayload) => {
    const url =
      typeof window === "undefined"
        ? "/api/session/complete"
        : new URL("/api/session/complete", window.location.origin).toString();

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      keepalive: true,
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Failed to complete interview");
    }

    return data;
  };

  const postRecoveryEventPayload = async (payload: Record<string, unknown>) => {
    const url =
      typeof window === "undefined"
        ? "/api/session/recovery-event"
        : new URL("/api/session/recovery-event", window.location.origin).toString();

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      keepalive: true,
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Failed to record recovery event");
    }

    return data;
  };

  const flushPendingTermination = async () => {
    if (typeof window === "undefined") {
      return;
    }

    const raw = window.localStorage.getItem(PENDING_TERMINATION_STORAGE_KEY);
    if (!raw) {
      return;
    }

    try {
      const payload = JSON.parse(raw) as TerminationPayload;
      await postTerminationPayload(payload);
      clearPendingTermination();
    } catch {
      // Keep the payload for the next retry opportunity.
    }
  };

  const flushPendingCompletion = async () => {
    if (typeof window === "undefined") {
      return;
    }

    const raw = window.localStorage.getItem(PENDING_COMPLETION_STORAGE_KEY);
    if (!raw) {
      return;
    }

    try {
      const payload = JSON.parse(raw) as CompletionPayload;
      await postJson("/api/session/complete", payload);
      clearPendingCompletion();
    } catch {
      // Keep the payload for the next retry opportunity.
    }
  };

  const flushPendingRecoveryEvent = async () => {
    if (typeof window === "undefined") {
      return;
    }

    const raw = window.localStorage.getItem(PENDING_RECOVERY_EVENT_STORAGE_KEY);
    if (!raw) {
      return;
    }

    try {
      const payload = JSON.parse(raw) as Record<string, unknown>;
      await postRecoveryEventPayload(payload);
      clearPendingRecoveryEvent();
    } catch {
      // Keep the forensic recovery event queued for the next reconnect.
    }
  };

  const clearHeartbeatLoop = () => {
    if (heartbeatIntervalRef.current !== null) {
      window.clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }

    if (heartbeatTimeoutRef.current !== null) {
      window.clearTimeout(heartbeatTimeoutRef.current);
      heartbeatTimeoutRef.current = null;
    }
  };

  const clearReconnectSchedulers = () => {
    if (reconnectTimeoutHandleRef.current !== null) {
      window.clearTimeout(reconnectTimeoutHandleRef.current);
      reconnectTimeoutHandleRef.current = null;
    }

    if (reconnectCountdownIntervalRef.current !== null) {
      window.clearInterval(reconnectCountdownIntervalRef.current);
      reconnectCountdownIntervalRef.current = null;
    }
  };

  const recordReconnectState = async (
    reason: string,
    metadata: Record<string, unknown> = {}
  ) => {
    if (!attemptId) {
      return;
    }

    await postJson("/api/interview/reconnect-state", {
      attemptId,
      reason,
      source: "candidate_calm_room",
      metadata: {
        ...metadata,
        sessionQuestionId: sessionQuestionId || null,
        requestId: reconnectRequestIdRef.current,
      },
    });
  };

  const sendHeartbeat = async ({
    reconnecting = false,
  }: {
    reconnecting?: boolean;
  } = {}) => {
    if (!attemptId || !interviewId || interviewFinished || interviewInterrupted) {
      return;
    }

    const heartbeatPromise = postJson("/api/interview/heartbeat", {
      interviewId,
      attemptId,
      sessionId: reconnectRequestIdRef.current,
      timestamp: new Date().toISOString(),
      reconnecting,
    });

    const timeoutPromise = new Promise((_, reject) => {
      heartbeatTimeoutRef.current = window.setTimeout(() => {
        reject(new Error("Heartbeat timed out"));
      }, HEARTBEAT_TIMEOUT_MS);
    });

    await Promise.race([heartbeatPromise, timeoutPromise]).finally(() => {
      if (heartbeatTimeoutRef.current !== null) {
        window.clearTimeout(heartbeatTimeoutRef.current);
        heartbeatTimeoutRef.current = null;
      }
    });
  };

  const pauseInterviewFlow = () => {
    // Freeze timers and capture the active answer state so reconnect can resume
    // without silently skipping question time.
    pausedPhaseRef.current = verisState;
    shouldResumeListeningRef.current =
      verisState === "listening" && !showCoding && !sessionTimeEnded;
    shouldResumeAudioAnalysisRef.current =
      verisState === "listening" && !showCoding && !sessionTimeEnded;
    reconnectPauseStartedAtRef.current = Date.now();

    stopAll();
    stopAudioAnalysis();
    clearInterval(timerRef.current);
    clearTimeout(inactivityTimeoutRef.current);
    clearHeartbeatLoop();
    setVerisState("thinking");
  };

  const resumeInterviewFlow = () => {
    // Shift server-relative timers forward by the disconnect duration so the
    // interview clock and per-question window remain fair after recovery.
    const pausedAt = reconnectPauseStartedAtRef.current;
    if (pausedAt) {
      const delta = Date.now() - pausedAt;
      interviewStartTimeRef.current = interviewStartTimeRef.current
        ? interviewStartTimeRef.current + delta
        : interviewStartTimeRef.current;
      questionStartTimeRef.current = questionStartTimeRef.current
        ? questionStartTimeRef.current + delta
        : questionStartTimeRef.current;
      setSessionEndsAt((current) => (current ? current + delta : current));
    }

    reconnectPauseStartedAtRef.current = null;
    setVerisState(pausedPhaseRef.current === "idle" ? "thinking" : pausedPhaseRef.current);
    startRecordingTimer();
    resetInactivityTimeout();

    if (shouldResumeListeningRef.current && !showCoding && !sessionTimeEnded) {
      setVerisState("listening");
      startListening();
    }

    if (shouldResumeAudioAnalysisRef.current && !showCoding && !sessionTimeEnded) {
      void startAudioAnalysis();
    }

    shouldResumeListeningRef.current = false;
    shouldResumeAudioAnalysisRef.current = false;
  };

  const sendSignal = async (type: string, value: unknown) => {
    if (!sessionQuestionId || !attemptId || isAdvancingRef.current) {
      return;
    }

    const payload = JSON.stringify(value);
    const now = Date.now();
    const lastSentAt = lastSignalSentRef.current[type] ?? 0;
    const lastPayload = lastSignalPayloadRef.current[type];
    const hasChanged = lastPayload !== payload;

    if (!hasChanged && now - lastSentAt < 3000) {
      return;
    }

    lastSignalSentRef.current[type] = now;
    lastSignalPayloadRef.current[type] = payload;
    const recordingAnchor =
      recordingStartedAtRef.current ?? interviewStartTimeRef.current;
    const recordingOffsetMs = recordingAnchor
      ? Math.max(0, now - recordingAnchor)
      : 0;
    const valueObject =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : { value };
    const enrichedValue = {
      ...valueObject,
      sessionQuestionId,
      recordingOffsetMs,
    };
    const recordingLabel = RECORDING_SIGNAL_LABELS[type];

    if (recordingLabel) {
      const severityValue = valueObject.severity;
      const severity =
        severityValue === "high" ||
        severityValue === "medium" ||
        severityValue === "low"
          ? severityValue
          : type === "tab_switch" || type === "multi_face"
            ? "high"
            : type === "no_face" || type === "long_gaze_away"
              ? "medium"
              : "low";

      setRecordingSignal({
        id: `${type}-${now}`,
        type,
        label: recordingLabel,
        severity,
        occurredAt: now,
        recordingOffsetMs,
      });

      if (recordingSignalTimeoutRef.current) {
        clearTimeout(recordingSignalTimeoutRef.current);
      }

      recordingSignalTimeoutRef.current = setTimeout(() => {
        setRecordingSignal(null);
        recordingSignalTimeoutRef.current = null;
      }, 6_000);
    }

    try {
      await postJson("/api/session/signal", {
          attemptId,
          type,
          value: enrichedValue,
      });
    } catch {
      lastSignalSentRef.current[type] = 0;
    }
  };

  const terminateInterview = async (
    terminationType: TerminationType,
    {
      useBeacon = false,
      message,
    }: {
      useBeacon?: boolean;
      message?: string;
    } = {}
  ) => {
    if (terminationInFlightRef.current) {
      return;
    }

    terminationInFlightRef.current = true;

    const payload = getTerminationPayload(terminationType);

    try {
      if (payload) {
        if (useBeacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
          const body = JSON.stringify(payload);
          const blob = new Blob([body], { type: "application/json" });
          const accepted = navigator.sendBeacon("/api/session/terminate", blob);

          if (!accepted) {
            persistPendingTermination(payload);
          } else {
            clearPendingTermination();
          }

          return;
        } else {
          try {
            const result = await postTerminationPayload(payload);
            clearPendingTermination();

            await endInterview({
              completed: result.completed,
              message:
                message ??
                `Interview ended early. Partial evaluation generated with ${result.completion_percentage}% completion and reliability score ${result.reliability_score}.`,
            });
            return;
          } catch {
            persistPendingTermination(payload);
          }
        }
      }

      await endInterview({
        completed: true,
        message:
          message ??
          "Interview ended early. Your partial responses will be finalized when the connection is restored.",
      });
    } finally {
      if (useBeacon) {
        return;
      }

      terminationInFlightRef.current = false;
      setExitEnding(false);
    }
  };

  const completeInterview = async (
    message = FINAL_COMPLETION_MESSAGE
  ) => {
    if (completionInFlightRef.current) {
      return;
    }

    completionInFlightRef.current = true;

    const payload = attemptId
      ? {
          attemptId,
          currentPhase: getCurrentPhaseFromState(verisState, showCoding),
        }
      : null;

    try {
      if (payload) {
        try {
          await postCompletionPayload(payload);
          clearPendingCompletion();
        } catch {
          persistPendingCompletion(payload);
        }
      }

      setVerisState("speaking");
      await Promise.race([
        speak(FINAL_VERIS_CLOSING_LINE),
        new Promise((resolve) => setTimeout(resolve, 8000)),
      ]);

      await endInterview({
        completed: true,
        message,
        finalizeRecording: false,
      });
    } finally {
      completionInFlightRef.current = false;
    }
  };

  const markInterviewInterrupted = async (
    classifier: string,
    reason: string,
    options: { useBeacon?: boolean } = {}
  ) => {
    if (!attemptId || terminationInFlightRef.current) {
      return;
    }

    const payload = {
      attemptId,
      classifier,
      reason,
      source: "candidate_calm_room",
      idempotencyKey: `${attemptId}:${classifier}:${sessionQuestionId || "no-question"}`,
      metadata: {
        sessionQuestionId: sessionQuestionId || null,
        questionId: questionId || null,
        currentQuestion: currentQuestion || null,
        transcriptBuffer: transcriptRef.current.trim() || transcript.trim() || null,
        currentPhase: getCurrentPhaseFromState(verisState, showCoding),
        serverEndsAt: sessionEndsAt ? new Date(sessionEndsAt).toISOString() : null,
        browserOnline: typeof navigator !== "undefined" ? navigator.onLine : null,
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
      },
    };

    try {
      if (options.useBeacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
        const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
        const accepted = navigator.sendBeacon("/api/session/recovery-event", blob);
        if (!accepted) {
          persistPendingRecoveryEvent(payload);
        }
      } else {
        await postRecoveryEventPayload(payload);
        clearPendingRecoveryEvent();
      }
    } catch {
      persistPendingRecoveryEvent(payload);
    }

    setInterviewInterrupted(true);
    await endInterview({
      completed: false,
      message:
        "Your interview was interrupted. A recovery attempt may be issued by recruiter.",
    });
  };

  const exitReconnectMode = async ({
    verifyHeartbeat = true,
  }: {
    verifyHeartbeat?: boolean;
  } = {}) => {
    clearReconnectSchedulers();
    reconnectInFlightRef.current = false;
    reconnectCurrentAttemptRef.current = 0;
    setReconnectAttempt(0);
    setReconnectCountdownMs(0);
    setReconnectReason("");
    setMediaRecoveryError("");
    setIsReconnecting(false);

    resumeInterviewFlow();

    if (verifyHeartbeat) {
      try {
        await sendHeartbeat({ reconnecting: true });
      } catch {
        // The next scheduled heartbeat will retry if this one races with recovery.
      }
    }
  };

  const performReconnectAttempt = async (attemptNumber: number) => {
    if (
      reconnectInFlightRef.current ||
      interviewFinished ||
      interviewInterrupted ||
      !attemptId
    ) {
      return;
    }

    reconnectInFlightRef.current = true;
    reconnectCurrentAttemptRef.current = attemptNumber;
    setReconnectAttempt(attemptNumber);
    setMediaRecoveryError("");

    try {
      if (!navigator.onLine) {
        throw new Error("Waiting for internet connection");
      }

      await flushPendingRecoveryEvent();
      await flushPendingTermination();
      await flushPendingCompletion();
      await sendHeartbeat({ reconnecting: true });

      setVideoReconnectKey((current) => current + 1);
      setCameraReady(false);
      setMicrophoneReady(false);

      window.setTimeout(() => {
        setCameraReady(true);
        setMicrophoneReady(true);
      }, 1200);

      await exitReconnectMode();
    } catch (error) {
      reconnectInFlightRef.current = false;

      if (isDatabaseCapacityError(error)) {
        clearReconnectSchedulers();
        setWarning({
          type: "soft",
          message:
            "Session health check is delayed. Your interview can continue while the system retries in the background.",
          visible: true,
        });
        await exitReconnectMode({ verifyHeartbeat: false });
        return;
      }

      if (attemptNumber >= MAX_RECONNECT_ATTEMPTS) {
        setMediaRecoveryError(
          "We could not restore your secure session automatically. The interview will be safely closed."
        );
        void terminateInterview("network_disconnect_timeout", {
          message:
            "Interview ended because the connection could not be restored in time.",
        });
        return;
      }

      const delay =
        RECONNECT_BACKOFF_MS[Math.min(attemptNumber - 1, RECONNECT_BACKOFF_MS.length - 1)];
      setReconnectReason(
        error instanceof Error ? error.message : "Reconnection attempt failed"
      );
      setReconnectCountdownMs(delay);

      if (reconnectCountdownIntervalRef.current !== null) {
        window.clearInterval(reconnectCountdownIntervalRef.current);
      }

      reconnectCountdownIntervalRef.current = window.setInterval(() => {
        setReconnectCountdownMs((current) => Math.max(0, current - 1000));
      }, 1000);

      reconnectTimeoutHandleRef.current = window.setTimeout(() => {
        reconnectInFlightRef.current = false;
        void performReconnectAttempt(attemptNumber + 1);
      }, delay);
    }
  };

  const enterReconnectMode = async (
    reason: string,
    source: string,
    metadata: Record<string, unknown> = {}
  ) => {
    if (
      !started ||
      !attemptId ||
      interviewFinished ||
      interviewInterrupted ||
      terminationInFlightRef.current ||
      isReconnecting
    ) {
      return;
    }

    setIsReconnecting(true);
    setReconnectReason(reason);
    setReconnectAttempt(1);
    setReconnectCountdownMs(0);
    setMediaRecoveryError("");
    setNetworkOnline(typeof navigator === "undefined" ? true : navigator.onLine);
    pauseInterviewFlow();

    try {
      await recordReconnectState(reason, {
        source,
        ...metadata,
      });
    } catch {
      // The reconnect overlay should still proceed even if forensic logging is delayed.
    }

    const eventPayload = {
      attemptId,
      classifier: "RECONNECTING",
      reason,
      source,
      idempotencyKey: `${attemptId}:RECONNECTING:${Date.now()}`,
      metadata: {
        sessionQuestionId: sessionQuestionId || null,
        questionId: questionId || null,
        currentQuestion: currentQuestion || null,
        transcriptBuffer: transcriptRef.current.trim() || transcript.trim() || null,
        currentPhase: getCurrentPhaseFromState(verisState, showCoding),
        ...metadata,
      },
    };

    try {
      await postRecoveryEventPayload(eventPayload);
      clearPendingRecoveryEvent();
    } catch {
      persistPendingRecoveryEvent(eventPayload);
    }

    void performReconnectAttempt(1);
  };

  const resetInactivityTimeout = () => {
    clearTimeout(inactivityTimeoutRef.current);

    if (!started || showCoding || terminationInFlightRef.current || isReconnecting) {
      return;
    }

    inactivityTimeoutRef.current = setTimeout(() => {
      void sendSignal("unresponsive", {
        severity: "high",
        inactivitySeconds: Math.round(INACTIVITY_TIMEOUT_MS / 1000),
        detectedAt: new Date().toISOString(),
      });
      void terminateInterview("timeout", {
        message:
          "Interview ended due to inactivity. A partial evaluation has been generated from your recorded responses.",
      });
    }, INACTIVITY_TIMEOUT_MS);
  };

  const resetFocusMetrics = () => {
    const now = Date.now();

    focusTimeMsRef.current = 0;
    focusTotalMsRef.current = 0;
    focusSampleAtRef.current = now;
    isLookingRef.current = faceDetected && attention;
    lookAwayStartRef.current = isLookingRef.current ? null : now;
    lookAwayEventsRef.current = 0;
    maxLookAwayMsRef.current = 0;
  };

  const finalizeFocusMetrics = () => {
    const now = Date.now();

    if (focusSampleAtRef.current !== null) {
      const delta = Math.max(0, now - focusSampleAtRef.current);
      focusTotalMsRef.current += delta;

      if (isLookingRef.current) {
        focusTimeMsRef.current += delta;
      }
    }

    if (!isLookingRef.current && lookAwayStartRef.current !== null) {
      const lookAwayDuration = now - lookAwayStartRef.current;
      maxLookAwayMsRef.current = Math.max(
        maxLookAwayMsRef.current,
        lookAwayDuration
      );

      if (lookAwayDuration >= 3000) {
        lookAwayEventsRef.current += 1;
      }
    }

    const totalAnswerMs =
      focusTotalMsRef.current ||
      (questionStartTimeRef.current ? now - questionStartTimeRef.current : 0);
    const focusRatio =
      totalAnswerMs > 0 ? focusTimeMsRef.current / totalAnswerMs : 1;

    return {
      focusRatio: roundMetric(focusRatio, 3),
      lookAwayEvents: lookAwayEventsRef.current,
      maxLookAwayDuration: roundMetric(maxLookAwayMsRef.current / 1000, 1),
      totalAnswerTime: roundMetric(totalAnswerMs / 1000, 1),
      assessment:
        focusRatio < 0.4 || maxLookAwayMsRef.current >= 8000
          ? "high_risk"
          : focusRatio < 0.6
            ? "suspicious"
            : focusRatio < 0.8
              ? "normal"
              : "excellent",
    };
  };

  const collectBehaviorSignalsForCurrentQuestion = (): BehaviorSignalPayload[] => {
    const startedAt = questionStartTimeRef.current ?? 0;
    const relevantTypes = new Set([
      "multi_face",
      "no_face",
      "attention_loss",
      "long_gaze_away",
      "tab_switch",
    ]);

    return events
      .filter(
        (event) =>
          event.timestamp >= startedAt && relevantTypes.has(event.type)
      )
      .map((event) => ({
        type: event.type,
        severity: event.severity,
        meta: event.meta,
        timestamp: event.timestamp,
      }));
  };

  const enterFullscreen = async () => {
    setInterviewFinished(false);
    try {
      if (
        !document.fullscreenElement &&
        typeof document.documentElement.requestFullscreen === "function"
      ) {
        await document.documentElement.requestFullscreen();
      }
    } catch (error) {
      console.warn(
        "Fullscreen mode is unavailable; continuing the interview in the current window.",
        error
      );
    }
    setStarted(true);
  };

  const endInterview = async ({
    completed = false,
    message,
    finalizeRecording = true,
  }: {
    completed?: boolean;
    message?: string;
    finalizeRecording?: boolean;
  } = {}) => {
    exitIntentRef.current = true;

    if (finalizeRecording) {
      try {
        await recordingFinalizerRef.current?.();
      } catch (error) {
        console.error("Unable to finalize recording before ending interview:", error);
      }
    }

    if (document.fullscreenElement) {
      await document.exitFullscreen();
    }

    setInterviewFinished(completed);
    if (message) {
      setCompletionMessage(message);
    }
    setStarted(false);
    setShowExit(false);
    setExitEnding(false);
    setIsTransitioning(false);
    setVerisState("idle");
    setCurrentQuestion("");
    setCurrentQuestionType(InterviewQuestionType.TECHNICAL_DISCUSSION);
    setSessionQuestionId("");
    setQuestionId("");
    setInterviewId("");
    setSessionEndsAt(null);
    setSessionTimeEnded(false);
    setAnswerWindowEnded(false);
    setTranscript("");
    transcriptRef.current = "";
    isAdvancingRef.current = false;

    stopAll();
    stopAudioAnalysis();
    clearInterval(timerRef.current);
    clearTimeout(inactivityTimeoutRef.current);
    clearTimeout(disconnectTimeoutRef.current);
    clearHeartbeatLoop();
    clearReconnectSchedulers();
    reconnectInFlightRef.current = false;
    interviewStartTimeRef.current = null;
    recordingFinalizerRef.current = null;
    questionStartTimeRef.current = null;
    setTimeLeft(0);
    setIsReconnecting(false);
    setReconnectAttempt(0);
    setReconnectReason("");
    setReconnectCountdownMs(0);
    setMediaRecoveryError("");

    const score = calculateFraudScore(events, {
      questionType: currentQuestionType,
    });
    const risk = classifyRisk(score);

    console.log("🧠 FINAL TIMELINE:", events);
    console.log("⚖️ FRAUD SCORE:", score);
    console.log("🚨 RISK LEVEL:", risk);
  };

  const handleExit = async () => {
    if (exitEnding || terminationInFlightRef.current) {
      return;
    }

    setExitEnding(true);
    setShowExit(false);

    const exitMessage =
      "Interview ended early. Your completed responses were saved and partial evaluation will continue securely.";

    const finalizeRecording = recordingFinalizerRef.current;
    void finalizeRecording?.().catch((error) => {
      console.error("Unable to finalize recording after manual exit:", error);
    });

    await endInterview({
      completed: true,
      message: exitMessage,
      finalizeRecording: false,
    });

    void terminateInterview("manual_exit", {
      message:
        "Interview ended early. Your completed responses were saved and scored as a partial interview.",
    });
  };

  useEffect(() => {
    void flushPendingTermination();
    void flushPendingCompletion();
    void flushPendingRecoveryEvent();
  }, []);

  useEffect(() => {
    return () => {
      clearHeartbeatLoop();
      clearReconnectSchedulers();
    };
  }, []);

  useEffect(() => {
    if (!started || !inviteToken) return;
    void startInterview();
  }, [inviteToken, started]);

  useEffect(() => {
    if (!started) return;

    const handleFullscreenChange = () => {
      if (document.fullscreenElement) return;

      if (exitIntentRef.current) {
        exitIntentRef.current = false;
        return;
      }

      setShowExit(true);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, [started]);

  useEffect(() => {
    resetInactivityTimeout();

    return () => {
      clearTimeout(inactivityTimeoutRef.current);
    };
  }, [isReconnecting, started, sessionQuestionId, transcript, showCoding]);

  useEffect(() => {
    if (!started || !attemptId || interviewFinished || interviewInterrupted) {
      return;
    }

    const handleOffline = () => {
      setNetworkOnline(false);
      clearTimeout(disconnectTimeoutRef.current);
      disconnectTimeoutRef.current = setTimeout(() => {
        void enterReconnectMode(
          "Network connection interrupted.",
          "browser_offline",
          {
            browserOnline: false,
          }
        );
      }, DISCONNECT_GRACE_MS);
    };

    const handleOnline = () => {
      setNetworkOnline(true);
      clearTimeout(disconnectTimeoutRef.current);
      void flushPendingTermination();
      void flushPendingCompletion();
      void flushPendingRecoveryEvent();

      if (isReconnecting) {
        clearReconnectSchedulers();
        reconnectInFlightRef.current = false;
        void performReconnectAttempt(Math.max(1, reconnectCurrentAttemptRef.current || 1));
      }
    };

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);

    return () => {
      clearTimeout(disconnectTimeoutRef.current);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, [
    attemptId,
    enterReconnectMode,
    interviewFinished,
    interviewInterrupted,
    isReconnecting,
    started,
  ]);

  useEffect(() => {
    if (!started || !attemptId) {
      return;
    }

    const handlePageHide = () => {
      if (terminationInFlightRef.current) {
        return;
      }

      const payload = getTerminationPayload("tab_close");
      if (!payload) {
        return;
      }

      persistPendingRecoveryEvent({
        attemptId: payload.attemptId,
        classifier: "BROWSER_CLOSE",
        reason: "Browser page closed or refreshed",
        source: "candidate_calm_room",
        idempotencyKey: `${payload.attemptId}:BROWSER_CLOSE:${sessionQuestionId || "no-question"}`,
        metadata: {
          sessionQuestionId: sessionQuestionId || null,
          transcriptBuffer: transcriptRef.current.trim() || transcript.trim() || null,
          currentPhase: payload.currentPhase,
          pageLifecycle: "pagehide",
        },
      });
      void terminateInterview("tab_close", {
        useBeacon: true,
        message: "Browser page closed or refreshed.",
      });
    };

    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("beforeunload", handlePageHide);

    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("beforeunload", handlePageHide);
    };
  }, [attemptId, started, transcript, sessionQuestionId, verisState, showCoding]);

  useEffect(() => {
    if (!interviewFinished || !attemptId) {
      return;
    }

    const handleCompletedPageHide = () => {
      const payload = {
        attemptId,
        currentPhase: "closing",
      } satisfies CompletionPayload;

      persistPendingCompletion(payload);

      if (typeof navigator !== "undefined" && navigator.sendBeacon) {
        const body = JSON.stringify(payload);
        const blob = new Blob([body], { type: "application/json" });
        const accepted = navigator.sendBeacon("/api/session/complete", blob);

        if (accepted) {
          clearPendingCompletion();
        }

        return;
      }

      void postCompletionPayload(payload)
        .then(() => {
          clearPendingCompletion();
        })
        .catch(() => undefined);
    };

    window.addEventListener("pagehide", handleCompletedPageHide);
    window.addEventListener("beforeunload", handleCompletedPageHide);

    return () => {
      window.removeEventListener("pagehide", handleCompletedPageHide);
      window.removeEventListener("beforeunload", handleCompletedPageHide);
    };
  }, [attemptId, interviewFinished]);

  const askQuestion = async (
    question: string,
    nextSessionQuestionId: string,
    nextQuestionId?: string | null,
    questionType?: string | null
  ) => {
    const resolvedQuestionType = normalizeInterviewQuestionType(
      questionType,
      classifyInterviewQuestion(question).questionType
    );
    const shouldCaptureSpokenAnswer =
      resolvedQuestionType !== InterviewQuestionType.CODING;

    stopAll();
    stopAudioAnalysis();
    acceptingTranscriptRef.current = false;
    isAdvancingRef.current = false;

    setTranscript("");
    transcriptRef.current = "";
    currentQuestionRef.current = question;
    setSessionQuestionId(nextSessionQuestionId);
    setQuestionId(nextQuestionId || nextSessionQuestionId);
    setCurrentQuestion(question);
    setCurrentQuestionType(resolvedQuestionType);
    setVerisState("thinking");
    setShowCoding(false);
    resetInactivityTimeout();

    if (shouldCaptureSpokenAnswer) {
      startListening();
    }

    setVerisState("speaking");
    await speak(question);
    if (shouldCaptureSpokenAnswer && !recognitionRef.current) {
      startListening();
    }
    recognitionRef.current?.resetTranscript?.();
    setTranscript("");
    transcriptRef.current = "";

    questionStartTimeRef.current = Date.now();
    setAnswerWindowEnded(false);
    resetFocusMetrics();
    startQuestionTimer();

    if (!shouldCaptureSpokenAnswer) {
      addEvent({
        type: "coding_start",
        severity: "low",
      });
      setVerisState("idle");
      setShowCoding(true);
      return;
    }

    acceptingTranscriptRef.current = true;
    setVerisState("listening");
    startAudioAnalysis();
  };

  const startInterview = async () => {
    try {
      setIsTransitioning(true);
      setInterviewFinished(false);
      interviewStartTimeRef.current = Date.now();
      recordingStartedAtRef.current = null;
      setTimeLeft(0);
      startRecordingTimer();

      const session = await postJson<{
        attemptId: string;
        interviewId: string;
        attemptNumber?: number;
        reused: boolean;
        endsAt?: string | Date | null;
        serverNow?: string | null;
        candidateId?: string | null;
        candidateName?: string | null;
      }>("/api/session/start", {
        token: inviteToken,
      });

      setAttemptId(session.attemptId);
      setInterviewId(session.interviewId);
      serverClockOffsetMsRef.current = session.serverNow
        ? new Date(session.serverNow).getTime() - Date.now()
        : 0;
      setSessionEndsAt(session.endsAt ? new Date(session.endsAt).getTime() : null);
      setCandidateId(session.candidateId?.trim() ?? "");
      setCandidateName(session.candidateName?.trim() ?? "");

      const questionPromise = postJson<{
        content: string;
        question_id?: string | null;
        session_question_id: string;
        question_type?: string | null;
      }>("/api/session/question", {
        attemptId: session.attemptId,
        content: "Explain your experience",
        source: "system",
      });
      const [data, recordingReady] = await Promise.all([
        questionPromise,
        waitForRecordingStartup(),
      ]);

      if (!recordingReady) {
        console.warn(
          "Recording did not confirm startup before the first VERIS question."
        );
      }

      setIsTransitioning(false);
      await askQuestion(
        data.content,
        data.session_question_id,
        data.question_id ?? data.session_question_id,
        data.question_type
      );
    } catch (error) {
      setIsTransitioning(false);
      setWarning({
        type: "hard",
        message:
          error instanceof Error
            ? error.message
            : "Failed to start the interview session.",
        visible: true,
      });
    }
  };

  const submitAnswer = async (options: { allowPendingTranscription?: boolean } = {}) => {
    if (!sessionQuestionId || !attemptId || !candidateId || !questionId) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const rawTranscript = transcriptRef.current.trim() || transcript.trim();
    const cleanedTranscript = cleanTranscript(
      rawTranscript
    );
    const safeTranscript = isInvalidCandidateTranscript({
      transcript: cleanedTranscript,
      questionText: currentQuestion,
    })
      ? ""
      : cleanedTranscript;
    const answerDuration = questionStartTimeRef.current
      ? Math.max(1, Math.round((Date.now() - questionStartTimeRef.current) / 1000))
      : 0;
    const focusMetrics = finalizeFocusMetrics() satisfies FocusMetrics;
    const behaviorSignals = collectBehaviorSignalsForCurrentQuestion();

    const answer = await postJson<{
      answer_id: string;
      answer_text: string | null;
    }>("/api/session/answer", {
        sessionQuestionId,
        questionId,
        questionText: currentQuestion,
        candidateId,
        attemptId,
        transcript: safeTranscript,
        rawTranscript: rawTranscript || safeTranscript,
        duration: answerDuration,
        allowPendingTranscription: options.allowPendingTranscription === true,
      });

    const answerText = answer.answer_text
      ? cleanTranscript(answer.answer_text)
      : "";
    if (answerText) {
      await postJson("/api/session/evaluate-answer", {
        answerId: answer.answer_id,
        sessionQuestionId,
        transcript: answerText,
        rawTranscript: rawTranscript || answerText,
        focusMetrics,
        behaviorSignals,
      });
    }

    resetInactivityTimeout();

    void postJson("/api/session/signal", {
      attemptId,
      type: "focus_metrics",
      value: {
        ...focusMetrics,
        sessionQuestionId,
      },
    }).catch(() => undefined);
  };

  const submitCodeAnswer = async (code: string, language: string) => {
    if (!sessionQuestionId || !attemptId || !candidateId || !questionId) {
      throw new Error("Coding session is not ready yet. Please wait a moment and try again.");
    }

    const answerDuration = questionStartTimeRef.current
      ? Math.max(1, Math.round((Date.now() - questionStartTimeRef.current) / 1000))
      : 0;

    await postJson("/api/session/code-answer", {
      sessionQuestionId,
      questionId,
      candidateId,
      attemptId,
      code,
      language,
      duration: answerDuration,
      prompt: currentQuestion,
    });

    resetInactivityTimeout();
  };

  const getNextQuestion = async () => {
    if (!attemptId) {
      throw new Error("Interview session is not initialized.");
    }

    const data = await postJson<{
      complete: boolean;
      message?: string;
      question?: string;
      question_id?: string | null;
      session_question_id?: string;
      question_type?: string | null;
    }>("/api/session/next-question", {
      attemptId,
    });

    if (data.complete || !data.question || !data.session_question_id) {
      try {
        await recordingFinalizerRef.current?.();
      } catch (error) {
        console.error("Unable to finalize recording before interview completion:", error);
      }

      setVerisState("speaking");
      await Promise.race([
        speak(FINAL_VERIS_CLOSING_LINE),
        new Promise((resolve) => setTimeout(resolve, 8000)),
      ]);
      await endInterview({
        completed: true,
        message: FINAL_COMPLETION_MESSAGE,
        finalizeRecording: false,
      });
      return;
    }

    await askQuestion(
      data.question,
      data.session_question_id,
      data.question_id ?? data.session_question_id,
      data.question_type
    );
  };

  const completeAfterFinalAnswer = async () => {
    if (!attemptId) {
      return;
    }

    try {
      await recordingFinalizerRef.current?.();
    } catch (error) {
      console.error("Unable to finalize recording before interview completion:", error);
    }

    const completionPayload = {
      attemptId,
      currentPhase: "closing",
    } satisfies CompletionPayload;

    try {
      await postCompletionPayload(completionPayload);
      clearPendingCompletion();
    } catch {
      persistPendingCompletion(completionPayload);
    }

    setVerisState("speaking");
    await Promise.race([
      speak(FINAL_VERIS_CLOSING_LINE),
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ]);
    await endInterview({
      completed: true,
      message: FINAL_COMPLETION_MESSAGE,
      finalizeRecording: false,
    });
  };

  const handleCodingSubmit = async (payload: {
    code: string;
    language: string;
  }) => {
    if (isAdvancingRef.current) return;
    isAdvancingRef.current = true;

    setIsTransitioning(true);
    setVerisState("thinking");

    try {
      await submitCodeAnswer(payload.code, payload.language);
      stopAll();
      stopAudioAnalysis();
      addEvent({
        type: "coding_end",
        severity: "low",
      });
      setShowCoding(false);
      if (sessionTimeEnded) {
        await completeAfterFinalAnswer();
      } else {
        await getNextQuestion();
      }
      setIsTransitioning(false);
    } catch (error) {
      isAdvancingRef.current = false;
      setIsTransitioning(false);
      setWarning({
        type: "hard",
        message:
          error instanceof Error
            ? error.message
            : "Failed to submit the coding answer.",
        visible: true,
      });
      throw error;
    }
  };

  const startListening = () => {
    listeningActiveRef.current = true;
    recognitionRef.current = startRecognition(
      (text) => {
        if (!acceptingTranscriptRef.current) return;

        const nextTranscript = text.trim();
        if (!nextTranscript) return;
        if (
          isInvalidCandidateTranscript({
            transcript: nextTranscript,
            questionText: currentQuestionRef.current,
          })
        ) {
          return;
        }

        transcriptRef.current = nextTranscript;
        setTranscript(nextTranscript);
      },
      () => {
        recognitionRef.current = null;
        setMicrophoneReady(false);

        if (!listeningActiveRef.current || isAdvancingRef.current) {
          return;
        }

        window.setTimeout(() => {
          if (listeningActiveRef.current && !recognitionRef.current && !isAdvancingRef.current) {
            startListening();
          }
        }, 250);
      },
      (text) => {
        if (!acceptingTranscriptRef.current) return;

        const nextTranscript = text.trim();
        if (!nextTranscript || nextTranscript.length < transcriptRef.current.length) {
          return;
        }
        if (
          isInvalidCandidateTranscript({
            transcript: nextTranscript,
            questionText: currentQuestionRef.current,
          })
        ) {
          return;
        }

        transcriptRef.current = nextTranscript;
        setTranscript(nextTranscript);
      }
    );
    setMicrophoneReady(Boolean(recognitionRef.current));
  };

  const stopAll = () => {
    listeningActiveRef.current = false;
    acceptingTranscriptRef.current = false;
    stopRecognition(recognitionRef.current);
    recognitionRef.current = null;
    setMicrophoneReady(false);

    clearTimeout(questionTimeoutRef.current);
    clearTimeout(silenceTimer.current);
  };

  const startRecordingTimer = () => {
    clearInterval(timerRef.current);

    timerRef.current = setInterval(() => {
      const startTime = interviewStartTimeRef.current;
      if (!startTime) return;

      const serverNow = Date.now() + serverClockOffsetMsRef.current;
      setTimeLeft(Math.max(0, Math.floor((serverNow - startTime) / 1000)));
    }, 1000);
  };

  const startQuestionTimer = () => {
    clearTimeout(questionTimeoutRef.current);
  };

  // 🎤 AUDIO ANALYSIS (FIXED CLEANUP)
  const startAudioAnalysis = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: SPEECH_AUDIO_CONSTRAINTS,
      });
      audioStreamRef.current = stream;
      setMicrophoneReady(true);

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();

      analyser.fftSize = 256;
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const update = () => {
        analyser.getByteFrequencyData(dataArray);
        const avg =
          dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

        setAudioLevel(avg / 255);
        requestAnimationFrame(update);
      };

      update();
    } catch (err) {
      setMicrophoneReady(false);
      console.error(err);
    }
  };

  const stopAudioAnalysis = () => {
    audioStreamRef.current?.getTracks().forEach((t) => t.stop());
    audioStreamRef.current = null;
    setMicrophoneReady(false);

    const context = audioContextRef.current;
    audioContextRef.current = null;

    if (context && context.state !== "closed") {
      void context.close().catch((error) => {
        console.error("Audio cleanup error:", error);
      });
    }
  };

  const handleAutoNext = async (options: { allowPendingTranscription?: boolean } = {}) => {
    if (isAdvancingRef.current) return;
    if (showCoding) {
      setWarning({
        type: "soft",
        message: "Please submit your coding answer to continue.",
        visible: true,
      });
      return;
    }

    const capturedTranscript = cleanTranscript(
      transcriptRef.current.trim() || transcript.trim()
    );
    const hasValidTranscript = Boolean(capturedTranscript) && !isInvalidCandidateTranscript({
      transcript: capturedTranscript,
      questionText: currentQuestion,
    });
    if (!options.allowPendingTranscription && !hasValidTranscript) {
      setWarning({
        type: "hard",
        message: "We heard activity but could not capture your words. Please check that the browser microphone is enabled, repeat your answer, and then select Next Question. Your interview has not advanced.",
        visible: true,
      });
      if (!recognitionRef.current) {
        startListening();
      }
      return;
    }
    isAdvancingRef.current = true;

    stopAll();
    stopAudioAnalysis();

    setVerisState("thinking");
    setShowCoding(false);
    setIsTransitioning(true);

    try {
      await submitAnswer(options);
      if (sessionTimeEnded) {
        await completeAfterFinalAnswer();
      } else {
        await getNextQuestion();
      }
      setIsTransitioning(false);
    } catch (error) {
      isAdvancingRef.current = false;
      setIsTransitioning(false);
      setWarning({
        type: "hard",
        message:
          error instanceof Error
            ? error.message
            : "Connection issue while saving the response.",
        visible: true,
      });
    }
  };

  handleAutoNextRef.current = handleAutoNext;

  // 🚨 TAB DETECTION
  useEffect(() => {
    if (!started) return;

    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        if (STRICT_TAB_TERMINATION) {
          void terminateInterview("tab_close", {
            message:
              "Interview ended because tab switching is blocked in strict mode. A partial evaluation has been generated.",
          });
          return;
        }

        setTabViolations((prev) => {
          const newCount = prev + 1;

          addEvent({
            type: "tab_switch",
            severity: "high",
            meta: { count: newCount },
          });
          void sendSignal("tab_switch", {
            severity: "high",
            count: newCount,
            detectedAt: new Date().toISOString(),
          });

          if (newCount >= 3) {
            setWarning({
              type: "hard",
              message: "Multiple tab switches detected. Interview terminated.",
              visible: true,
            });

            setTimeout(() => {
              void terminateInterview("tab_close", {
                message:
                  "Interview ended after repeated tab switches. A partial evaluation has been generated.",
              });
            }, 2000);
          } else {
            setWarning({
              type: "hard",
              message: `Tab switch detected (${newCount}/3).`,
              visible: true,
            });
          }

          return newCount;
        });
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibility);
  }, [started]);

  // 👁️ FACE / ATTENTION EVENTS
  useEffect(() => {
    if (!started) return;

    if (multiFace) {
      addEvent({
        type: "multi_face",
        severity: "high",
      });

        setWarning({
          type: "hard",
          message: "Ensure only you are visible.",
          visible: true,
        });
    } else if (!faceDetected) {
      addEvent({
        type: "no_face",
        severity: "medium",
      });

      setWarning({
        type: "soft",
        message: "Please stay in frame.",
        visible: true,
      });
    } else if (!attention) {
      addEvent({
        type: "attention_loss",
        severity: "low",
      });
    }
  }, [multiFace, faceDetected, attention, started]);

  useEffect(() => {
    if (!started) return;

    void sendSignal("face_detected", {
      faces: faceCount,
      confidence: faceDetected ? 0.92 : 0,
      attention,
      multiFace,
    });
  }, [attention, faceCount, faceDetected, multiFace, sessionQuestionId, started]);

  useEffect(() => {
    if (!started || faceDetected) return;

    void sendSignal("no_face", {
      faces: faceCount,
      attention,
    });
  }, [attention, faceCount, faceDetected, sessionQuestionId, started]);

  useEffect(() => {
    if (!started || !multiFace) return;

    void sendSignal("multi_face", {
      faces: faceCount,
      attention,
    });
  }, [attention, faceCount, multiFace, sessionQuestionId, started]);

  useEffect(() => {
    if (!started || !faceDetected || attention) return;

    void sendSignal("attention_loss", {
      faces: faceCount,
      attention,
    });
  }, [attention, faceCount, faceDetected, sessionQuestionId, started]);

  // 👁️ LONG GAZE DETECTION
  useEffect(() => {
    if (!started) return;

    let timer: any;
    let startTime: number | null = null;

    if (!attention) {
      startTime = Date.now();

      timer = setInterval(() => {
        if (!startTime) return;

        if (Date.now() - startTime >= 30000) {
          addEvent({
            type: "long_gaze_away",
            severity: "medium",
            meta: { duration: 30000 },
          });
          void sendSignal("long_gaze_away", {
            severity: "medium",
            durationMs: 30000,
            detectedAt: new Date().toISOString(),
          });

          setWarning({
            type: "soft",
            message: "Please look at the camera.",
            visible: true,
          });

          clearInterval(timer);
        }
      }, 1000);
    }

    return () => timer && clearInterval(timer);
  }, [attention, started]);

  // 📋 CODE EVENTS
  useEffect(() => {
    const handler = (e: any) => {
      const type = e.detail?.type;
      if (!type) return;

      addEvent({
        type,
        severity: "medium",
      });
    };

    window.addEventListener("hireveri-event", handler);
    return () => window.removeEventListener("hireveri-event", handler);
  }, []);

  useEffect(() => {
    if (!started || !sessionQuestionId || !questionStartTimeRef.current) return;

    const now = Date.now();
    const currentIsLooking = faceDetected && attention;

    if (focusSampleAtRef.current !== null) {
      const delta = Math.max(0, now - focusSampleAtRef.current);
      focusTotalMsRef.current += delta;

      if (isLookingRef.current) {
        focusTimeMsRef.current += delta;
      }
    }

    if (isLookingRef.current && !currentIsLooking) {
      lookAwayStartRef.current = now;
    }

    if (
      !isLookingRef.current &&
      currentIsLooking &&
      lookAwayStartRef.current !== null
    ) {
      const lookAwayDuration = now - lookAwayStartRef.current;
      maxLookAwayMsRef.current = Math.max(
        maxLookAwayMsRef.current,
        lookAwayDuration
      );

      if (lookAwayDuration >= 3000) {
        lookAwayEventsRef.current += 1;
      }

      lookAwayStartRef.current = null;
    }

    isLookingRef.current = currentIsLooking;
    focusSampleAtRef.current = now;
  }, [attention, faceDetected, sessionQuestionId, started]);

  useEffect(() => {
    if (!started) {
      setSessionTimeEnded(false);
      setAnswerWindowEnded(false);
      return;
    }

    const tick = () => {
      if (isReconnecting) {
        return;
      }

      const now = Date.now() + serverClockOffsetMsRef.current;

      setSessionTimeEnded(Boolean(sessionEndsAt && now >= sessionEndsAt));
      setAnswerWindowEnded(
        Boolean(
          questionStartTimeRef.current &&
            now - questionStartTimeRef.current >= MAX_ANSWER_TIME_MS
        )
      );
    };

    tick();
    const timer = window.setInterval(tick, 1000);

    return () => window.clearInterval(timer);
  }, [isReconnecting, sessionEndsAt, sessionQuestionId, started]);

  useEffect(() => {
    if (
      !answerWindowEnded ||
      sessionTimeEnded ||
      !started ||
      !sessionQuestionId ||
      interviewFinished ||
      interviewInterrupted ||
      isReconnecting ||
      showCoding ||
      isAdvancingRef.current
    ) {
      return;
    }

    // A timed-out spoken answer must advance instead of trapping the candidate
    // behind disabled controls. submitAnswer persists any transcript captured so
    // far (or a recoverable recording-backed placeholder) before moving on.
    void handleAutoNextRef.current?.({ allowPendingTranscription: true });
  }, [
    answerWindowEnded,
    interviewFinished,
    interviewInterrupted,
    isReconnecting,
    sessionQuestionId,
    sessionTimeEnded,
    showCoding,
    started,
  ]);

  useEffect(() => {
    if (
      !sessionTimeEnded ||
      !started ||
      !attemptId ||
      interviewFinished ||
      interviewInterrupted ||
      isReconnecting ||
      showCoding ||
      isAdvancingRef.current
    ) {
      return;
    }

    // Preserve the active response before finalizing at the overall time limit.
    // handleAutoNext submits the buffered transcript and then follows the
    // completeAfterFinalAnswer path because sessionTimeEnded is true.
    void handleAutoNextRef.current?.({ allowPendingTranscription: true });
  }, [
    attemptId,
    interviewFinished,
    interviewInterrupted,
    isReconnecting,
    sessionTimeEnded,
    showCoding,
    started,
  ]);

  useEffect(() => {
    if (
      !started ||
      !attemptId ||
      !interviewId ||
      interviewFinished ||
      interviewInterrupted ||
      isReconnecting
    ) {
      clearHeartbeatLoop();
      return;
    }

    let cancelled = false;

    const pulse = async () => {
      // Application-level heartbeat protects against silent websocket or network
      // failures that do not always surface through browser events.
      try {
        await sendHeartbeat();
        consecutiveHeartbeatFailuresRef.current = 0;
      } catch (error) {
        if (isDatabaseCapacityError(error)) {
          consecutiveHeartbeatFailuresRef.current = 0;
          console.warn("Heartbeat skipped because the database pool is saturated.", error);
          return;
        }

        consecutiveHeartbeatFailuresRef.current += 1;
        console.warn("Interview heartbeat failed", {
          consecutiveFailures: consecutiveHeartbeatFailuresRef.current,
          error,
        });

        if (!cancelled && consecutiveHeartbeatFailuresRef.current >= 3) {
          consecutiveHeartbeatFailuresRef.current = 0;
          await enterReconnectMode(
            error instanceof Error
              ? error.message
              : "Unable to verify secure session health.",
            "heartbeat_failure",
            {
              browserOnline: typeof navigator === "undefined" ? true : navigator.onLine,
            }
          );
        }
      }
    };

    void pulse();
    heartbeatIntervalRef.current = window.setInterval(() => {
      void pulse();
    }, HEARTBEAT_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearHeartbeatLoop();
    };
  }, [
    attemptId,
    interviewFinished,
    interviewId,
    interviewInterrupted,
    isReconnecting,
    started,
  ]);

  useEffect(() => {
    if (!started || !attemptId) {
      return;
    }

    let stopped = false;

    const syncActions = async () => {
      try {
        const data = await postJson<{
          actions: Array<{
            actionId: string;
            actionType: string;
            recommendation: string | null;
            note: string | null;
            createdAt: string;
          }>;
          syncedAt: string;
        }>("/api/session/war-room-actions", {
          attemptId,
          since: lastWarRoomSyncAtRef.current,
        });

        if (data.actions.length > 0) {
          lastWarRoomSyncAtRef.current =
            data.actions[data.actions.length - 1]?.createdAt ?? data.syncedAt;

          const latest = data.actions[data.actions.length - 1];
          addEvent({
            type: "war_room_action",
            severity:
              latest.actionType === "flag_candidate" ? "high" : "medium",
            meta: latest,
          });
        }
      } catch {
        // War-room sync is opportunistic; the next poll or reconnect will retry.
      }
    };

    void syncActions();
    const interval = window.setInterval(() => {
      if (!stopped) {
        void syncActions();
      }
    }, 5000);

    return () => {
      stopped = true;
      window.clearInterval(interval);
    };
  }, [attemptId, started]);

  if (interviewFinished) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-[#0B0F1A] px-6 text-white">
        <div className="max-w-xl text-center">
          <p className="mb-4 text-xs uppercase tracking-[0.28em] text-emerald-300/80">
            Finished
          </p>
          <h1 className="mb-4 text-3xl font-medium tracking-[0.04em]">
            Interview Completed
          </h1>
          <p className="text-sm leading-7 text-white/72 md:text-base">
            {completionMessage}
          </p>
        </div>
      </div>
    );
  }

  if (interviewInterrupted) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-[#0B0F1A] px-6 text-white">
        <div className="max-w-xl text-center">
          <p className="mb-4 text-xs uppercase tracking-[0.28em] text-cyan-300/70">
            Session Interrupted
          </p>
          <h1 className="mb-4 text-3xl font-medium tracking-[0.04em]">
            Your interview was interrupted.
          </h1>
          <p className="text-sm leading-7 text-white/72 md:text-base">
            A recovery attempt may be issued by recruiter.
          </p>
        </div>
      </div>
    );
  }

  if (!entryReady) {
    return (
      <InterviewEntryGate
        token={inviteToken}
        onReadyForPrecheck={() => setEntryReady(true)}
      />
    );
  }

  if (!started) {
    return <PrecheckScreen onStart={enterFullscreen} />;
  }

  return (
    <>
      <CalmLayout>
        <CalmHeader />

        <WarningOverlay {...warning} />
        <ReconnectOverlay
          visible={isReconnecting}
          attempt={Math.max(1, reconnectAttempt)}
          maxAttempts={MAX_RECONNECT_ATTEMPTS}
          countdownSeconds={Math.max(1, Math.ceil(reconnectCountdownMs / 1000))}
          networkOnline={networkOnline}
          cameraReady={cameraReady}
          microphoneReady={microphoneReady}
          reason={reconnectReason}
          mediaRecoveryError={mediaRecoveryError || null}
          onRetry={() => {
            reconnectInFlightRef.current = false;
            clearReconnectSchedulers();
            void performReconnectAttempt(
              Math.max(1, reconnectCurrentAttemptRef.current || 1)
            );
          }}
        />

        <main className="relative z-[1] mx-auto grid w-full max-w-[1440px] flex-1 grid-cols-1 gap-4 px-4 py-4 sm:px-6 lg:min-h-0 lg:grid-cols-[minmax(0,1.7fr)_minmax(340px,0.85fr)] lg:gap-5 lg:px-8 lg:py-5">
          <div className="flex min-w-0 flex-col justify-center">
            <VideoPanel
              attemptId={attemptId}
              candidateName={candidateName}
              timeLeft={timeLeft}
              reconnectKey={videoReconnectKey}
              sessionQuestionId={sessionQuestionId}
              questionText={currentQuestion}
              transcript={transcript}
              verisState={verisState}
              recordingSignal={recordingSignal}
              onRecordingStarted={(startedAt) => {
                recordingStartedAtRef.current = startedAt;
              }}
              onRecordingFinalizerChange={(finalize) => {
                recordingFinalizerRef.current = finalize;
              }}
              onVideoReady={(ref) => (videoRef.current = ref.current)}
              onCameraStatusChange={(ready, reason) => {
                setCameraReady(ready);
                if (!ready && reason && started && !interviewFinished && !interviewInterrupted) {
                  void enterReconnectMode(
                    reason === "track_ended"
                      ? "Camera track ended unexpectedly."
                      : "Camera could not be accessed.",
                    reason === "track_ended" ? "camera_track_ended" : "camera_acquisition_failed",
                    { cameraFailureReason: reason }
                  );
                }
              }}
              onRoomConnectionChange={(state) => {
                if (state === "connected") {
                  setNetworkOnline(true);
                  return;
                }

                // LiveKit performs its own transient reconnection. Restarting
                // the component here tears down that recovery and used to
                // create a false "realtime interview interrupted" record.
                if (state === "reconnecting") {
                  return;
                }

                if (started && !interviewFinished && !interviewInterrupted) {
                  void enterReconnectMode(
                    "Realtime interview connection ended unexpectedly.",
                    "livekit_disconnected",
                    {
                      roomState: state,
                    }
                  );
                }
              }}
            />
            <AmbientMic
              active={started && microphoneReady && !interviewFinished && !interviewInterrupted}
              attemptId={attemptId}
              videoRef={videoRef}
              resetKey={videoReconnectKey}
            />

            <SystemIndicators
              faceCount={faceCount}
              micActive={verisState === "listening"}
              attention={attention}
              secure={true}
              verisState={verisState}
            />
          </div>

          <aside className="flex min-h-[360px] flex-col rounded-[20px] border border-white/[0.09] bg-[#0d131e]/95 p-5 shadow-[0_24px_70px_rgba(0,0,0,0.24)] sm:p-6">
            <div className="flex items-center gap-4 border-b border-white/[0.07] pb-5">
              <VerisOrb state={verisState} audioLevel={audioLevel} />
              <div>
                <p className="text-sm font-semibold text-slate-100">
                  {verisState === "listening"
                    ? "Veris is listening"
                    : verisState === "speaking"
                      ? "Veris is speaking"
                      : "Veris is preparing"}
                </p>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  {verisState === "listening"
                    ? "Take your time and answer naturally."
                    : "Please listen carefully to the full question."}
                </p>
              </div>
            </div>

            <div className="flex flex-1 flex-col pt-6">
              <QuestionRenderer
                question={currentQuestion}
                questionType={currentQuestionType}
              />

              <div className="mt-6 rounded-lg border border-white/[0.06] bg-black/10 px-3.5 py-3">
                <p className="text-[11px] leading-5 text-slate-500">
                  Your response is recorded securely. You may pause briefly to
                  organize your thoughts before continuing.
                </p>
              </div>

              <InterviewControls
                disabled={isTransitioning || isReconnecting}
                skipDisabled={sessionTimeEnded}
                primaryLabel={sessionTimeEnded ? "Finish Answer" : "Next Question"}
                message={
                  answerWindowEnded
                    ? "Time limit reached. Saving your response and continuing..."
                    : sessionTimeEnded
                      ? "Finish your current answer"
                      : undefined
                }
                onNext={() => void handleAutoNext()}
                onSkip={() => void handleAutoNext({ allowPendingTranscription: true })}
              />
            </div>
          </aside>
        </main>

        <button
          onClick={() => {
            if (!exitEnding && !terminationInFlightRef.current) {
              setShowExit(true);
            }
          }}
          disabled={exitEnding || terminationInFlightRef.current}
          className="absolute right-4 top-[19px] z-20 rounded-md border border-white/10 px-3 py-2 text-[11px] font-medium text-slate-400 transition hover:border-red-300/20 hover:bg-red-300/[0.06] hover:text-red-200 sm:right-8"
        >
          {exitEnding ? "Ending..." : "Exit"}
        </button>
      </CalmLayout>

      {showCoding ? (
        <CodeEditorModal
          open={showCoding}
          question={currentQuestion}
          onSubmit={handleCodingSubmit}
          onClose={() => {
            setWarning({
              type: "soft",
              message: "Please submit your coding answer to continue.",
              visible: true,
            });
          }}
        />
      ) : null}

      {showExit && (
        <ExitModal
          onConfirm={handleExit}
          onCancel={() => {
            if (exitEnding) {
              return;
            }
            setShowExit(false);
            void document.documentElement.requestFullscreen();
          }}
          busy={exitEnding}
        />
      )}
    </>
  );
}
