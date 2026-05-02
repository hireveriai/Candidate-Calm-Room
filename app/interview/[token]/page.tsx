"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";

import CalmLayout from "@/app/components/calm/core/CalmLayout";
import CalmHeader from "@/app/components/calm/core/CalmHeader";
import VideoPanel from "@/app/components/calm/core/VideoPanel";
import TranscriptStream from "@/app/components/calm/core/TranscriptStream";
import SystemIndicators from "@/app/components/calm/core/SystemIndicators";
import InterviewControls from "@/app/components/calm/core/InterviewControls";
import PrecheckScreen from "@/app/components/calm/flow/PrecheckScreen";
import ExitModal from "@/app/components/calm/flow/ExitModal";

import WarningOverlay from "@/app/components/calm/system/WarningOverlay";

import {
  speak,
  startRecognition,
  stopRecognition,
} from "@/app/services/verisVoice";

import useCognitiveSignals from "@/app/hooks/useCognitiveSignals";
import useEventTimeline from "@/app/hooks/useEventTimeline";

import {
  calculateFraudScore,
  classifyRisk,
} from "@/app/utils/fraudEngine";

type VerisState = "idle" | "listening" | "thinking" | "speaking";
type TerminationType =
  | "manual_exit"
  | "tab_close"
  | "disconnect"
  | "timeout";

type TerminationPayload = {
  attemptId: string;
  terminationType: TerminationType;
  sessionQuestionId?: string;
  transcript?: string;
  duration?: number;
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
const STRICT_TAB_TERMINATION = false;
const PENDING_TERMINATION_STORAGE_KEY = "hireveri.pendingTermination";
const PENDING_COMPLETION_STORAGE_KEY = "hireveri.pendingCompletion";

function isCodingQuestionType(questionType: string | null | undefined) {
  return /code|coding|programming/i.test(questionType ?? "");
}

function cleanTranscript(text: string) {
  const collapsed = text
    .replace(/\s+/g, " ")
    .replace(/\b(um|uh|erm|hmm)\b/gi, "")
    .replace(/\s+,/g, ",")
    .replace(/\s+\./g, ".")
    .trim();

  const repeatedSentence = /(.{15,}?[.!?])(?:\s+\1)+/gi;
  const withoutRepeatedSentences = collapsed.replace(repeatedSentence, "$1");

  const repeatedPhrase = /\b([\w']+(?:\s+[\w']+){2,6})\s+\1\b/gi;
  const withoutRepeatedPhrases = withoutRepeatedSentences.replace(
    repeatedPhrase,
    "$1"
  );

  const sentenceCased =
    withoutRepeatedPhrases.charAt(0).toUpperCase() +
    withoutRepeatedPhrases.slice(1);

  if (!sentenceCased) {
    return "";
  }

  return /[.!?]$/.test(sentenceCased) ? sentenceCased : `${sentenceCased}.`;
}

function roundMetric(value: number, digits = 2) {
  return Number(value.toFixed(digits));
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

  const [started, setStarted] = useState(false);
  const [interviewFinished, setInterviewFinished] = useState(false);
  const [completionMessage, setCompletionMessage] = useState(
    "Interview complete. Thank you for your time."
  );
  const [showExit, setShowExit] = useState(false);

  const [verisState, setVerisState] = useState<VerisState>("idle");
  const [currentQuestion, setCurrentQuestion] = useState("");
  const [sessionQuestionId, setSessionQuestionId] = useState("");
  const [transcript, setTranscript] = useState("");
  const [timeLeft, setTimeLeft] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [attemptId, setAttemptId] = useState("");

  const [audioLevel, setAudioLevel] = useState(0);

  const recognitionRef = useRef<any>(null);
  const silenceTimer = useRef<any>(null);
  const timerRef = useRef<any>(null);
  const questionTimeoutRef = useRef<any>(null);
  const inactivityTimeoutRef = useRef<any>(null);
  const disconnectTimeoutRef = useRef<any>(null);
  const interviewStartTimeRef = useRef<number | null>(null);
  const questionStartTimeRef = useRef<number | null>(null);
  const focusTimeMsRef = useRef(0);
  const focusTotalMsRef = useRef(0);
  const focusSampleAtRef = useRef<number | null>(null);
  const isLookingRef = useRef(true);
  const lookAwayStartRef = useRef<number | null>(null);
  const lookAwayEventsRef = useRef(0);
  const maxLookAwayMsRef = useRef(0);
  const exitIntentRef = useRef(false);
  const transcriptRef = useRef("");
  const isAdvancingRef = useRef(false);
  const terminationInFlightRef = useRef(false);
  const lastSignalSentRef = useRef<Record<string, number>>({});
  const lastSignalPayloadRef = useRef<Record<string, string>>({});

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

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    document.title = candidateName
      ? `Interview Room — ${candidateName}`
      : "Interview Room";
  }, [candidateName]);

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

  const postJson = async <T,>(path: string, body: unknown): Promise<T> => {
    const url =
      typeof window === "undefined"
        ? path
        : new URL(path, window.location.origin).toString();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: "POST",
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
          throw error;
        }

        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }

    throw new Error("Request failed");
  };

  const getTerminationPayload = (
    terminationType: TerminationType
  ): TerminationPayload | null => {
    if (!attemptId) {
      return null;
    }

    const cleanedTranscript = cleanTranscript(
      transcriptRef.current.trim() || transcript.trim()
    );
    const duration = questionStartTimeRef.current
      ? Math.max(1, Math.round((Date.now() - questionStartTimeRef.current) / 1000))
      : undefined;

    return {
      attemptId,
      terminationType,
      sessionQuestionId: sessionQuestionId || undefined,
      transcript: cleanedTranscript || undefined,
      duration,
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

    try {
      await postJson("/api/session/signal", {
          attemptId,
          type,
          value,
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
    }
  };

  const resetInactivityTimeout = () => {
    clearTimeout(inactivityTimeoutRef.current);

    if (!started || showCoding || terminationInFlightRef.current) {
      return;
    }

    inactivityTimeoutRef.current = setTimeout(() => {
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
    await document.documentElement.requestFullscreen();
    setStarted(true);
  };

  const endInterview = async ({
    completed = false,
    message,
  }: {
    completed?: boolean;
    message?: string;
  } = {}) => {
    exitIntentRef.current = true;

    if (document.fullscreenElement) {
      await document.exitFullscreen();
    }

    setInterviewFinished(completed);
    if (message) {
      setCompletionMessage(message);
    }
    setStarted(false);
    setShowExit(false);
    setIsTransitioning(false);
    setVerisState("idle");
    setCurrentQuestion("");
    setSessionQuestionId("");
    setTranscript("");
    transcriptRef.current = "";
    isAdvancingRef.current = false;

    stopAll();
    stopAudioAnalysis();
    clearInterval(timerRef.current);
    clearTimeout(inactivityTimeoutRef.current);
    clearTimeout(disconnectTimeoutRef.current);
    interviewStartTimeRef.current = null;
    questionStartTimeRef.current = null;
    setTimeLeft(0);

    const score = calculateFraudScore(events);
    const risk = classifyRisk(score);

    console.log("🧠 FINAL TIMELINE:", events);
    console.log("⚖️ FRAUD SCORE:", score);
    console.log("🚨 RISK LEVEL:", risk);
  };

  const handleExit = async () => {
    await terminateInterview("manual_exit", {
      message:
        "Interview exited early. A partial evaluation has been generated from your submitted responses.",
    });
  };

  useEffect(() => {
    void flushPendingTermination();
    void flushPendingCompletion();
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
  }, [started, sessionQuestionId, transcript, showCoding]);

  useEffect(() => {
    if (!started || !attemptId) {
      return;
    }

    const handleOffline = () => {
      clearTimeout(disconnectTimeoutRef.current);
      disconnectTimeoutRef.current = setTimeout(() => {
        void terminateInterview("disconnect", {
          message:
            "Interview ended because the connection was lost for too long. A partial evaluation has been generated.",
        });
      }, DISCONNECT_GRACE_MS);
    };

    const handleOnline = () => {
      clearTimeout(disconnectTimeoutRef.current);
      void flushPendingTermination();
    };

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);

    return () => {
      clearTimeout(disconnectTimeoutRef.current);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, [attemptId, started, transcript, sessionQuestionId, verisState, showCoding]);

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

      persistPendingTermination(payload);
      void terminateInterview("tab_close", { useBeacon: true });
    };

    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("beforeunload", handlePageHide);

    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("beforeunload", handlePageHide);
    };
  }, [attemptId, started, transcript, sessionQuestionId, verisState, showCoding]);

  const askQuestion = async (
    question: string,
    nextSessionQuestionId: string,
    questionType?: string | null
  ) => {
    stopAll();
    stopAudioAnalysis();
    isAdvancingRef.current = false;

    setTranscript("");
    transcriptRef.current = "";
    setSessionQuestionId(nextSessionQuestionId);
    setCurrentQuestion(question);
    setVerisState("thinking");
    setShowCoding(false);
    resetInactivityTimeout();

    setVerisState("speaking");
    await speak(question);

    questionStartTimeRef.current = Date.now();
    resetFocusMetrics();
    startQuestionTimer();

    if (isCodingQuestionType(questionType)) {
      addEvent({
        type: "coding_start",
        severity: "low",
      });
      setVerisState("idle");
      setShowCoding(true);
      return;
    }

    setVerisState("listening");
    startListening();
    startAudioAnalysis();
  };

  const startInterview = async () => {
    try {
      setIsTransitioning(true);
      setInterviewFinished(false);
      interviewStartTimeRef.current = Date.now();
      setTimeLeft(0);
      startRecordingTimer();

      const session = await postJson<{
        attemptId: string;
        interviewId: string;
        attemptNumber?: number;
        reused: boolean;
        candidateName?: string | null;
      }>("/api/session/start", {
        token: inviteToken,
      });

      setAttemptId(session.attemptId);
      setCandidateName(session.candidateName?.trim() ?? "");

      const data = await postJson<{
        content: string;
        session_question_id: string;
        question_type?: string | null;
      }>("/api/session/question", {
        attemptId: session.attemptId,
        content: "Explain your experience",
        source: "system",
      });

      setIsTransitioning(false);
      await askQuestion(
        data.content,
        data.session_question_id,
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

  const submitAnswer = async () => {
    if (!sessionQuestionId || !attemptId) return;
    const rawTranscript = transcriptRef.current.trim() || transcript.trim();
    const cleanedTranscript = cleanTranscript(
      rawTranscript
    );
    const safeTranscript = cleanedTranscript || "No response provided.";
    const answerDuration = questionStartTimeRef.current
      ? Math.max(1, Math.round((Date.now() - questionStartTimeRef.current) / 1000))
      : 0;
    const focusMetrics = finalizeFocusMetrics() satisfies FocusMetrics;
    const behaviorSignals = collectBehaviorSignalsForCurrentQuestion();

    const answer = await postJson<{
      answer_id: string;
      answer_text: string;
    }>("/api/session/answer", {
        sessionQuestionId,
        transcript: safeTranscript,
        duration: answerDuration,
      });

    await postJson("/api/session/evaluate-answer", {
      answerId: answer.answer_id,
      sessionQuestionId,
      transcript: answer.answer_text || safeTranscript,
      rawTranscript: rawTranscript || safeTranscript,
      focusMetrics,
      behaviorSignals,
    });

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
    if (!sessionQuestionId || !attemptId) return;

    const answerDuration = questionStartTimeRef.current
      ? Math.max(1, Math.round((Date.now() - questionStartTimeRef.current) / 1000))
      : 0;

    await postJson("/api/session/code-answer", {
      sessionQuestionId,
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

    const cleanedTranscript = cleanTranscript(
      transcriptRef.current.trim() || transcript.trim()
    );
    const safeTranscript = cleanedTranscript || "No response provided.";

    const data = await postJson<{
      complete: boolean;
      question?: string;
      session_question_id?: string;
      question_type?: string | null;
    }>("/api/session/next-question", {
      attemptId,
      lastAnswer: safeTranscript,
    });

    if (data.complete || !data.question || !data.session_question_id) {
      const completionPayload = {
        attemptId,
        currentPhase: getCurrentPhaseFromState(verisState, showCoding),
      } satisfies CompletionPayload;

      try {
        await postJson("/api/session/complete", completionPayload);
        clearPendingCompletion();
      } catch {
        persistPendingCompletion(completionPayload);
      }

      await endInterview({
        completed: true,
        message:
          "Interview complete. Your responses, including follow-up questions, have been recorded.",
      });
      return;
    }

    await askQuestion(
      data.question,
      data.session_question_id,
      data.question_type
    );
  };

  const handleCodingSubmit = async (payload: {
    code: string;
    language: string;
  }) => {
    if (isAdvancingRef.current) return;
    isAdvancingRef.current = true;

    stopAll();
    stopAudioAnalysis();

    addEvent({
      type: "coding_end",
      severity: "low",
    });

    setShowCoding(false);
    setIsTransitioning(true);
    setVerisState("thinking");

    try {
      await submitCodeAnswer(payload.code, payload.language);
      await getNextQuestion();
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
    }
  };

  const startListening = () => {
    recognitionRef.current = startRecognition(
      (text) => {
        const nextTranscript = text.trim();
        if (!nextTranscript) return;

        transcriptRef.current = nextTranscript;
        setTranscript(nextTranscript);
      }
    );
  };

  const stopAll = () => {
    stopRecognition(recognitionRef.current);
    recognitionRef.current = null;

    clearTimeout(questionTimeoutRef.current);
    clearTimeout(silenceTimer.current);
  };

  const startRecordingTimer = () => {
    clearInterval(timerRef.current);

    timerRef.current = setInterval(() => {
      const startTime = interviewStartTimeRef.current;
      if (!startTime) return;

      setTimeLeft(Math.max(0, Math.floor((Date.now() - startTime) / 1000)));
    }, 1000);
  };

  const startQuestionTimer = () => {
    clearTimeout(questionTimeoutRef.current);
  };

  // 🎤 AUDIO ANALYSIS (FIXED CLEANUP)
  const startAudioAnalysis = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioStreamRef.current = stream;

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
      console.error(err);
    }
  };

  const stopAudioAnalysis = () => {
    audioStreamRef.current?.getTracks().forEach((t) => t.stop());
    audioStreamRef.current = null;

    const context = audioContextRef.current;
    audioContextRef.current = null;

    if (context && context.state !== "closed") {
      void context.close().catch((error) => {
        console.error("Audio cleanup error:", error);
      });
    }
  };

  const handleAutoNext = async () => {
    if (isAdvancingRef.current) return;
    isAdvancingRef.current = true;

    stopAll();
    stopAudioAnalysis();

    if (showCoding) {
      addEvent({
        type: "coding_end",
        severity: "low",
      });
    }

    setVerisState("thinking");
    setShowCoding(false);
    setIsTransitioning(true);

    try {
      await submitAnswer();
      await getNextQuestion();
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

  if (interviewFinished) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-[#0B0F1A] px-6 text-white">
        <div className="max-w-xl text-center">
          <p className="mb-4 text-xs uppercase tracking-[0.28em] text-cyan-300/70">
            Session Complete
          </p>
          <h1 className="mb-4 text-3xl font-medium tracking-[0.04em]">
            Interview Finished
          </h1>
          <p className="text-sm leading-7 text-white/72 md:text-base">
            {completionMessage}
          </p>
        </div>
      </div>
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

        <VideoPanel
          timeLeft={timeLeft}
          onVideoReady={(ref) => (videoRef.current = ref.current)}
        />

        <SystemIndicators
          faceCount={faceCount}
          micActive={verisState === "listening"}
          attention={attention}
          secure={true}
          verisState={verisState}
        />

        <VerisOrb state={verisState} audioLevel={audioLevel} />

        <TranscriptStream text={currentQuestion} />

        <InterviewControls
          disabled={isTransitioning}
          onNext={() => void handleAutoNext()}
          onSkip={() => void handleAutoNext()}
        />

        <button
          onClick={() => setShowExit(true)}
          className="absolute top-4 right-6 text-sm text-red-400 border border-red-400/30 px-3 py-1 rounded-full"
        >
          Exit
        </button>
      </CalmLayout>

      {showCoding ? (
        <CodeEditorModal
          open={showCoding}
          question={currentQuestion}
          onSubmit={handleCodingSubmit}
          onClose={() => {
            addEvent({
              type: "coding_end",
              severity: "low",
            });

            setShowCoding(false);
            void handleAutoNext();
          }}
        />
      ) : null}

      {showExit && (
        <ExitModal
          onConfirm={handleExit}
          onCancel={() => {
            setShowExit(false);
            void document.documentElement.requestFullscreen();
          }}
        />
      )}
    </>
  );
}
