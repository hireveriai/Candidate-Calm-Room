"use client";

import { useEffect, useRef, useState } from "react";
import * as faceapi from "face-api.js";

type Props = {
  videoRef: React.RefObject<HTMLVideoElement | null>;
};

export default function useCognitiveSignals({ videoRef }: Props) {
  const [faceCount, setFaceCount] = useState(0);
  const [faceDetected, setFaceDetected] = useState(false);
  const [multiFace, setMultiFace] = useState(false);
  const [attention, setAttention] = useState(true);
  const [tabActive, setTabActive] = useState(true);
  const [audioAnomaly, setAudioAnomaly] = useState(false);

  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataArrayRef = useRef<Uint8Array | null>(null);

  // 🎥 FACE DETECTION LOOP
  useEffect(() => {
    let interval: any;

    const runDetection = async () => {
      if (!videoRef.current) return;

      interval = setInterval(async () => {
        const detections = await faceapi
          .detectAllFaces(
            videoRef.current!,
            new faceapi.TinyFaceDetectorOptions()
          )
          .withFaceLandmarks();

        const count = detections.length;

        setFaceCount(count);
        setFaceDetected(count >= 1);
        setMultiFace(count > 1);

        // 👁️ ATTENTION CHECK (simple deviation)
        if (count === 1) {
          const landmarks = detections[0].landmarks;
          const nose = landmarks.getNose()[3];
          const leftEye = landmarks.getLeftEye()[0];
          const rightEye = landmarks.getRightEye()[3];

          const eyeCenterX = (leftEye.x + rightEye.x) / 2;
          const deviation = Math.abs(nose.x - eyeCenterX);

          setAttention(deviation < 25);
        } else {
          setAttention(true);
        }
      }, 500);
    };

    runDetection();

    return () => clearInterval(interval);
  }, [videoRef]);

  // 🪟 TAB VISIBILITY
  useEffect(() => {
    const handleVisibility = () => {
      setTabActive(document.visibilityState === "visible");
    };

    document.addEventListener("visibilitychange", handleVisibility);

    return () =>
      document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  // 🔊 AUDIO ANALYSER
  useEffect(() => {
    let animationFrame: number;

    const setupAudio = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });

        const audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();

        analyser.fftSize = 256;
        source.connect(analyser);

        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        analyserRef.current = analyser;
        dataArrayRef.current = dataArray;

        const detect = () => {
          analyser.getByteFrequencyData(dataArray);

          const avg =
            dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

          setAudioAnomaly(avg > 180); // simple threshold

          animationFrame = requestAnimationFrame(detect);
        };

        detect();
      } catch (err) {
        console.error("Audio init error:", err);
      }
    };

    setupAudio();

    return () => cancelAnimationFrame(animationFrame);
  }, []);

  return {
    faceCount,
    faceDetected,
    multiFace,
    attention,
    tabActive,
    audioAnomaly,
  };
}