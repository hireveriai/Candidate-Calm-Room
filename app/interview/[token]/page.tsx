"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";

import CalmLayout from "@/app/components/calm/core/CalmLayout";
import CalmHeader from "@/app/components/calm/core/CalmHeader";
import VideoPanel from "@/app/components/calm/core/VideoPanel";
import VerisOrb from "@/app/components/calm/core/VerisOrb";
import TranscriptStream from "@/app/components/calm/core/TranscriptStream";
import SystemIndicators from "@/app/components/calm/core/SystemIndicators";
import InterviewControls from "@/app/components/calm/core/InterviewControls";
import CodeEditorModal from "@/app/components/calm/core/CodeEditorModal";
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

const QUESTION_DURATION_SECONDS = 90;

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

export default function Page() {
  const params = useParams<{ token: string }>();
  const inviteToken = typeof params?.token === "string" ? params.token : "";

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
  const lastSignalSentRef = useRef<Record<string, number>>({});
  const lastSignalPayloadRef = useRef<Record<string, string>>({});

  const videoRef = useRef<any>(null);

  const audioStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  const { faceCount, faceDetected, multiFace, attention } =
    useCognitiveSignals({ videoRef });

  const { events, addEvent } = useEventTimeline();

  const [warning, setWarning] = useState({
    type: "soft" as "soft" | "hard",
    message: "",
    visible: false,
  });

  const [, setTabViolations] = useState(0);
  const [showCoding, setShowCoding] = useState(false);

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
    await endInterview();
  };

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
      }>("/api/session/start", {
        token: inviteToken,
      });

      setAttemptId(session.attemptId);

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
    const cleanedTranscript = cleanTranscript(
      transcriptRef.current.trim() || transcript.trim()
    );
    const safeTranscript = cleanedTranscript || "No response provided.";
    const answerDuration = questionStartTimeRef.current
      ? Math.max(1, Math.round((Date.now() - questionStartTimeRef.current) / 1000))
      : 0;
    const focusMetrics = finalizeFocusMetrics();

    await Promise.all([
      postJson("/api/session/answer", {
        sessionQuestionId,
        transcript: safeTranscript,
        duration: answerDuration,
      }),
    ]);

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
      lastQuestion: currentQuestion,
      lastAnswer: safeTranscript,
    });

    if (data.complete || !data.question || !data.session_question_id) {
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

    questionTimeoutRef.current = setTimeout(() => {
      void handleAutoNext();
    }, QUESTION_DURATION_SECONDS * 1000);
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

            setTimeout(() => handleExit(), 2000);
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
