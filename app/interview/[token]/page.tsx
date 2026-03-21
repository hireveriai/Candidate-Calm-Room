"use client";

import { useEffect, useRef, useState } from "react";

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

type Question = {
  type: "text" | "coding";
  question: string;
};

const QUESTION_DURATION_SECONDS = 30;

export default function Page() {
  const [started, setStarted] = useState(false);
  const [showExit, setShowExit] = useState(false);

  const [verisState, setVerisState] = useState<VerisState>("idle");
  const [transcript, setTranscript] = useState("");

  const [questionIndex, setQuestionIndex] = useState(0);
  const [timeLeft, setTimeLeft] = useState(0);

  const [audioLevel, setAudioLevel] = useState(0);

  const recognitionRef = useRef<any>(null);
  const silenceTimer = useRef<any>(null);
  const timerRef = useRef<any>(null);
  const exitIntentRef = useRef(false);

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

  const [tabViolations, setTabViolations] = useState(0);
  const [showCoding, setShowCoding] = useState(false);

  const questions: Question[] = [
    { type: "text", question: "Tell me something about yourself." },
    { type: "coding", question: "Write a function to reverse a string." },
    { type: "text", question: "Why should we hire you?" },
  ];

  const currentQuestion = questions[questionIndex];

  const enterFullscreen = async () => {
    await document.documentElement.requestFullscreen();
    setStarted(true);
  };

  const handleExit = async () => {
    exitIntentRef.current = true;

    if (document.fullscreenElement) {
      await document.exitFullscreen();
    }

    setStarted(false);
    setShowExit(false);

    stopAll();
    stopAudioAnalysis();

    const score = calculateFraudScore(events);
    const risk = classifyRisk(score);

    console.log("🧠 FINAL TIMELINE:", events);
    console.log("⚖️ FRAUD SCORE:", score);
    console.log("🚨 RISK LEVEL:", risk);
  };

  useEffect(() => {
    if (!started) return;
    runQuestion();
  }, [started, questionIndex]);

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

  const runQuestion = async () => {
    stopAll();

    setTimeLeft(0);
    setTranscript("");
    setVerisState("thinking");

    await new Promise((r) => setTimeout(r, 800));

    setVerisState("speaking");
    setTranscript(currentQuestion.question);

    await speak(currentQuestion.question);

    if (currentQuestion.type === "coding") {
      setShowCoding(true);

      addEvent({
        type: "coding_start",
        severity: "low",
      });

      setVerisState("idle");
    } else {
      setVerisState("listening");
      startListening();
    }

    startTimer();
    startAudioAnalysis();
  };

  const startListening = () => {
    recognitionRef.current = startRecognition(
      () => {
        if (silenceTimer.current) clearTimeout(silenceTimer.current);

        silenceTimer.current = setTimeout(() => {
          handleAutoNext();
        }, 3000);
      },
      () => handleAutoNext()
    );
  };

  const stopAll = () => {
    stopRecognition(recognitionRef.current);
    recognitionRef.current = null;

    clearInterval(timerRef.current);
    clearTimeout(silenceTimer.current);
  };

  const startTimer = () => {
    timerRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev >= QUESTION_DURATION_SECONDS) {
          clearInterval(timerRef.current);
          handleAutoNext();
          return QUESTION_DURATION_SECONDS;
        }
        return prev + 1;
      });
    }, 1000);
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

  const handleAutoNext = () => {
    stopAll();

    if (showCoding) {
      addEvent({
        type: "coding_end",
        severity: "low",
      });
    }

    setVerisState("thinking");

    setTimeout(() => {
      setShowCoding(false);
      setQuestionIndex((prev) => (prev + 1) % questions.length);
    }, 800);
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
        message: "Multiple faces detected.",
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

        <TranscriptStream text={transcript} />

        <InterviewControls
          onNext={handleAutoNext}
          onSkip={handleAutoNext}
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
        question={currentQuestion.question}
        onClose={() => {
          addEvent({
            type: "coding_end",
            severity: "low",
          });

          setShowCoding(false);
          handleAutoNext();
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
