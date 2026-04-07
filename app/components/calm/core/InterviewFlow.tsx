"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import VerisOrb from "@/app/components/calm/core/VerisOrb";

export type InterviewFlowState =
  | "QUESTION_PLAYING"
  | "THINKING_BUFFER"
  | "COUNTDOWN"
  | "CANDIDATE_RESPONSE";

type InterviewFlowProps = {
  questionText?: string;
  questionPlayingMs?: number;
  thinkingBufferMs?: number;
  countdownSeconds?: number;
  responseWindowMs?: number;
  interviewEnded?: boolean;
  className?: string;
  onStateChange?: (state: InterviewFlowState) => void;
  onResponseStart?: () => void;
  onCycleComplete?: () => void;
};

type ContentConfig = {
  title: string;
  subtitle: string;
  orbState: "idle" | "listening" | "thinking" | "speaking";
  audioLevel: number;
  pulse: boolean;
  showWaveform: boolean;
  micActive: boolean;
};

const INITIAL_STATE: InterviewFlowState = "QUESTION_PLAYING";
const SOFT_TONE_DURATION_SECONDS = 0.18;
const SOFT_TONE_VOLUME = 0.018;
const SOFT_TONE_FREQUENCY = 523.25;

export default function InterviewFlow({
  questionText,
  questionPlayingMs = 5000,
  thinkingBufferMs = 2500,
  countdownSeconds = 5,
  responseWindowMs = 30000,
  interviewEnded = false,
  className = "",
  onStateChange,
  onResponseStart,
  onCycleComplete,
}: InterviewFlowProps) {
  const [currentState, setCurrentState] =
    useState<InterviewFlowState>(INITIAL_STATE);
  const [countdownValue, setCountdownValue] = useState(countdownSeconds);
  const [contentVisible, setContentVisible] = useState(true);
  const [isPaused, setIsPaused] = useState(false);
  const [cycleKey, setCycleKey] = useState(0);

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const phaseDeadlineRef = useRef<number | null>(null);
  const resumeRemainingMsRef = useRef<number | null>(null);
  const playedResponseToneRef = useRef(false);

  const clearTimers = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  const getPhaseDuration = (state: InterviewFlowState) => {
    switch (state) {
      case "QUESTION_PLAYING":
        return questionPlayingMs;
      case "THINKING_BUFFER":
        return thinkingBufferMs;
      case "COUNTDOWN":
        return countdownSeconds * 1000;
      case "CANDIDATE_RESPONSE":
        return responseWindowMs;
      default:
        return 0;
    }
  };

  const moveToNextState = (state: InterviewFlowState) => {
    switch (state) {
      case "QUESTION_PLAYING":
        setCurrentState("THINKING_BUFFER");
        return;
      case "THINKING_BUFFER":
        setCountdownValue(countdownSeconds);
        setCurrentState("COUNTDOWN");
        return;
      case "COUNTDOWN":
        setCurrentState("CANDIDATE_RESPONSE");
        return;
      case "CANDIDATE_RESPONSE":
        onCycleComplete?.();
        setCycleKey((value) => value + 1);
        setCurrentState("QUESTION_PLAYING");
        return;
      default:
        return;
    }
  };

  const playSoftTone = () => {
    if (typeof window === "undefined") return;

    const AudioContextCtor =
      window.AudioContext ||
      (window as typeof window & {
        webkitAudioContext?: typeof AudioContext;
      }).webkitAudioContext;

    if (!AudioContextCtor) return;

    try {
      const context = new AudioContextCtor();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const now = context.currentTime;

      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(SOFT_TONE_FREQUENCY, now);

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(SOFT_TONE_VOLUME, now + 0.03);
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        now + SOFT_TONE_DURATION_SECONDS
      );

      oscillator.connect(gain);
      gain.connect(context.destination);

      oscillator.start(now);
      oscillator.stop(now + SOFT_TONE_DURATION_SECONDS);

      oscillator.onended = () => {
        void context.close();
      };
    } catch {
      // Ignore autoplay and browser audio limitations.
    }
  };

  useEffect(() => {
    setContentVisible(false);

    const frame = window.requestAnimationFrame(() => {
      setContentVisible(true);
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [currentState, cycleKey]);

  useEffect(() => {
    if (interviewEnded) {
      clearTimers();
      phaseDeadlineRef.current = null;
      resumeRemainingMsRef.current = null;
      return;
    }

    if (isPaused) {
      return;
    }

    clearTimers();

    const durationMs =
      resumeRemainingMsRef.current ?? getPhaseDuration(currentState);
    resumeRemainingMsRef.current = null;
    phaseDeadlineRef.current = Date.now() + durationMs;

    onStateChange?.(currentState);

    if (currentState === "COUNTDOWN") {
      setCountdownValue(Math.max(Math.ceil(durationMs / 1000), 1));

      intervalRef.current = setInterval(() => {
        if (!phaseDeadlineRef.current) return;

        const remainingMs = Math.max(phaseDeadlineRef.current - Date.now(), 0);
        setCountdownValue(Math.max(Math.ceil(remainingMs / 1000), 1));
      }, 200);
    } else {
      setCountdownValue(countdownSeconds);
    }

    if (currentState === "CANDIDATE_RESPONSE") {
      if (!playedResponseToneRef.current) {
        playSoftTone();
        playedResponseToneRef.current = true;
      }

      onResponseStart?.();
    } else {
      playedResponseToneRef.current = false;
    }

    timeoutRef.current = setTimeout(() => {
      moveToNextState(currentState);
    }, durationMs);

    return () => {
      clearTimers();
    };
  }, [
    countdownSeconds,
    currentState,
    interviewEnded,
    isPaused,
    onCycleComplete,
    onResponseStart,
    onStateChange,
    questionPlayingMs,
    responseWindowMs,
    thinkingBufferMs,
  ]);

  useEffect(() => {
    if (typeof document === "undefined") return;

    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (interviewEnded || isPaused || !phaseDeadlineRef.current) {
          return;
        }

        resumeRemainingMsRef.current = Math.max(
          phaseDeadlineRef.current - Date.now(),
          0
        );
        clearTimers();
        setIsPaused(true);
        return;
      }

      if (!document.hidden && isPaused) {
        setIsPaused(false);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [interviewEnded, isPaused]);

  useEffect(() => {
    return () => {
      clearTimers();
    };
  }, []);

  const content = useMemo<ContentConfig>(() => {
    switch (currentState) {
      case "QUESTION_PLAYING":
        return {
          title: "Listen carefully",
          subtitle: questionText?.trim()
            ? questionText
            : "Veris is asking a question",
          orbState: "speaking",
          audioLevel: 0.88,
          pulse: false,
          showWaveform: false,
          micActive: false,
        };
      case "THINKING_BUFFER":
        return {
          title: "Take a moment to think",
          subtitle: "No rush. Gather your thoughts before you begin.",
          orbState: "thinking",
          audioLevel: 0.2,
          pulse: true,
          showWaveform: false,
          micActive: false,
        };
      case "COUNTDOWN":
        return {
          title: `Starting in ${countdownValue}...`,
          subtitle: "Veris will begin listening in just a moment.",
          orbState: "thinking",
          audioLevel: 0.16,
          pulse: true,
          showWaveform: false,
          micActive: false,
        };
      case "CANDIDATE_RESPONSE":
        return {
          title: "Your turn to respond",
          subtitle: "Veris is listening",
          orbState: "listening",
          audioLevel: 0.58,
          pulse: false,
          showWaveform: true,
          micActive: true,
        };
      default:
        return {
          title: "",
          subtitle: "",
          orbState: "idle",
          audioLevel: 0,
          pulse: false,
          showWaveform: false,
          micActive: false,
        };
    }
  }, [countdownValue, currentState, questionText]);

  return (
    <div
      className={`relative flex min-h-[420px] w-full items-center justify-center overflow-hidden px-6 py-12 ${className}`}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(34,211,238,0.12),transparent_38%),radial-gradient(circle_at_bottom,rgba(59,130,246,0.08),transparent_42%)]" />

      <div className="relative mx-auto flex w-full max-w-3xl flex-col items-center text-center">
        <div className={content.pulse ? "rounded-full animate-pulse" : "rounded-full"}>
          <VerisOrb state={content.orbState} audioLevel={content.audioLevel} />
        </div>

        <div className="mt-8 min-h-[150px] w-full max-w-2xl">
          <div
            className={`mx-auto flex max-w-xl flex-col items-center gap-4 rounded-[32px] border border-white/10 bg-white/[0.03] px-8 py-8 shadow-[0_24px_80px_rgba(2,6,23,0.45)] backdrop-blur-md transition-all duration-700 ease-out ${
              contentVisible
                ? "translate-y-0 opacity-100"
                : "translate-y-3 opacity-0"
            }`}
          >
            <span className="rounded-full border border-cyan-400/20 bg-cyan-400/8 px-3 py-1 text-[10px] uppercase tracking-[0.28em] text-cyan-200/80">
              {currentState.replace("_", " ")}
            </span>

            <h2 className="text-3xl font-medium tracking-[-0.03em] text-white sm:text-4xl">
              {content.title}
            </h2>

            <p className="max-w-lg text-sm leading-7 text-slate-300 sm:text-base">
              {content.subtitle}
            </p>

            <div className="mt-2 flex h-10 items-center justify-center">
              {content.showWaveform ? (
                <div className="flex items-center gap-1.5">
                  {Array.from({ length: 8 }).map((_, index) => (
                    <span
                      key={index}
                      className="block w-1.5 animate-pulse rounded-full bg-cyan-300/80"
                      style={{
                        height: `${14 + (index % 4) * 7}px`,
                        animationDuration: `${0.9 + index * 0.12}s`,
                        animationDelay: `${index * 0.08}s`,
                      }}
                    />
                  ))}
                </div>
              ) : (
                <div className="h-8" />
              )}
            </div>

            <div className="mt-1 flex items-center gap-2 text-xs uppercase tracking-[0.22em] text-white/45">
              <span
                className={`inline-flex h-2.5 w-2.5 rounded-full transition-all duration-500 ${
                  content.micActive
                    ? "bg-emerald-400 shadow-[0_0_12px_rgba(74,222,128,0.8)]"
                    : "bg-white/15"
                }`}
              />
              <span>{content.micActive ? "Microphone active" : "Stand by"}</span>
            </div>
          </div>
        </div>

        {isPaused && !interviewEnded && (
          <p className="mt-5 text-xs uppercase tracking-[0.18em] text-slate-400">
            Flow paused while this tab is inactive
          </p>
        )}
      </div>
    </div>
  );
}
