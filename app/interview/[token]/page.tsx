"use client";

import { useEffect, useRef, useState } from "react";

import CalmLayout from "@/app/components/calm/core/CalmLayout";
import VideoPanel from "@/app/components/calm/core/VideoPanel";
import VerisOrb from "@/app/components/calm/core/VerisOrb";
import TranscriptStream from "@/app/components/calm/core/TranscriptStream";
import SystemIndicators from "@/app/components/calm/core/SystemIndicators";
import InterviewControls from "@/app/components/calm/core/InterviewControls";
import QuestionTimer from "@/app/components/calm/core/QuestionTimer";
import CalmHeader from "@/app/components/calm/core/CalmHeader";
import PrecheckScreen from "@/app/components/calm/flow/PrecheckScreen";
import ExitModal from "@/app/components/calm/flow/ExitModal";

import {
  speak,
  startRecognition,
  stopRecognition,
} from "@/app/services/verisVoice";

type VerisState = "idle" | "listening" | "thinking" | "speaking";

export default function Page() {
  const [started, setStarted] = useState(false);
  const [showExit, setShowExit] = useState(false);

  const [verisState, setVerisState] = useState<VerisState>("idle");
  const [transcript, setTranscript] = useState("");

  const [questionIndex, setQuestionIndex] = useState(0);
  const [timeLeft, setTimeLeft] = useState(30);

  const recognitionRef = useRef<any>(null);
  const silenceTimer = useRef<any>(null);
  const timerRef = useRef<any>(null);

  const questions = [
    "Tell me something about yourself.",
    "What are your strengths?",
    "Why should we hire you?",
  ];

  const currentQuestion = questions[questionIndex];

  const enterFullscreen = async () => {
    await document.documentElement.requestFullscreen();
    setStarted(true);
  };

  const handleExit = () => {
    document.exitFullscreen();
    setStarted(false);
    setShowExit(false);
  };

  // 🧠 MAIN FLOW
  useEffect(() => {
    if (!started) return;

    runQuestion();
  }, [started, questionIndex]);

  const runQuestion = async () => {
    stopRecognition(recognitionRef.current);
    clearInterval(timerRef.current);

    setTimeLeft(30);
    setVerisState("thinking");
    setTranscript("");

    await new Promise((r) => setTimeout(r, 800));

    setVerisState("speaking");
    setTranscript(currentQuestion);

    await speak(currentQuestion);

    setVerisState("listening");
    startListening();
    startTimer();
  };

  // ⏱️ TIMER
  const startTimer = () => {
    timerRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timerRef.current);
          handleAutoNext();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  // 🎤 LISTENING
  const startListening = () => {
    recognitionRef.current = startRecognition(
      (text) => {
        setTranscript(text);

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

  // 🔄 AUTO NEXT
  const handleAutoNext = () => {
    stopAll();
    setVerisState("thinking");

    setTimeout(() => {
      setQuestionIndex((prev) => (prev + 1) % questions.length);
    }, 800);
  };

  // 🎮 CONTROLS
  const handleNext = () => handleAutoNext();
  const handleSkip = () => handleAutoNext();

  if (!started) {
    return <PrecheckScreen onStart={enterFullscreen} />;
  }

  return (
    <>
     <CalmLayout>

  {/* HEADER */}
  <CalmHeader />

  {/* TIMER */}
  <QuestionTimer timeLeft={timeLeft} />

  {/* VIDEO */}
  <VideoPanel />

  {/* INDICATORS */}
  <SystemIndicators
    faceDetected={true}
    micActive={verisState === "listening"}
    attention={true}
    secure={true}
    verisState={verisState}
  />

  {/* ORB */}
  <div className="mt-6">
    <VerisOrb state={verisState} />
  </div>

  {/* TRANSCRIPT */}
  <TranscriptStream text={transcript} />

  {/* CONTROLS */}
  <InterviewControls onNext={handleNext} onSkip={handleSkip} />

  {/* EXIT */}
  <button
    onClick={() => setShowExit(true)}
    className="absolute top-4 right-6 text-sm text-red-400 border border-red-400/30 px-3 py-1 rounded-full"
  >
    Exit
  </button>

</CalmLayout>

      {showExit && (
        <ExitModal
          onConfirm={handleExit}
          onCancel={() => {
            setShowExit(false);
            document.documentElement.requestFullscreen();
          }}
        />
      )}
    </>
  );
}