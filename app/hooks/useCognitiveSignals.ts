"use client";

import { useEffect, useState } from "react";
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

  useEffect(() => {
    let interval: any;

    const loadModels = async () => {
      console.log("🔄 Loading models...");
      await faceapi.nets.tinyFaceDetector.loadFromUri("/models");
      await faceapi.nets.faceLandmark68Net.loadFromUri("/models");
      console.log("✅ Models loaded");
    };

    const detect = async () => {
      if (!videoRef.current) return;

      const video = videoRef.current;

      // ✅ EXACT SAME CHECK AS YOUR WORKING VERSION
      if (video.readyState !== 4) {
        console.log("⛔ Video not ready");
        return;
      }

      try {
        // 🔥 USE detectAllFaces BUT WITH CONFIG (IMPORTANT)
        const detections = await faceapi
          .detectAllFaces(
            video,
            new faceapi.TinyFaceDetectorOptions({
              inputSize: 416,       // 👈 KEY FIX
              scoreThreshold: 0.3,  // 👈 MORE LENIENT
            })
          )
          .withFaceLandmarks();

        const count = detections.length;

        console.log("👀 Face count:", count);

        setFaceCount(count);
        setFaceDetected(count >= 1);
        setMultiFace(count > 1);

        // 👁️ ATTENTION (ONLY IF 1 FACE)
        if (count === 1) {
          const landmarks = detections[0].landmarks;

          const nose = landmarks.getNose()[3];
          const leftEye = landmarks.getLeftEye()[0];
          const rightEye = landmarks.getRightEye()[3];

          const eyeCenterX = (leftEye.x + rightEye.x) / 2;
          const deviation = Math.abs(nose.x - eyeCenterX);

          setAttention(deviation < 30);
        } else {
          setAttention(true);
        }

      } catch (err) {
        console.error("❌ Detection error:", err);
      }
    };

    const start = async () => {
      await loadModels();

      // ⏱️ SAME INTERVAL AS BEFORE (STABLE)
      interval = setInterval(detect, 1000);
    };

    start();

    return () => clearInterval(interval);
  }, [videoRef]);

  // 🪟 TAB DETECTION
  useEffect(() => {
    const handle = () => {
      setTabActive(document.visibilityState === "visible");
    };

    document.addEventListener("visibilitychange", handle);
    return () => document.removeEventListener("visibilitychange", handle);
  }, []);

  // 🔊 AUDIO ANOMALY (UNCHANGED)
  useEffect(() => {
    let frame: number;

    const setup = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

        const ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();

        analyser.fftSize = 256;
        src.connect(analyser);

        const data = new Uint8Array(analyser.frequencyBinCount);

        const loop = () => {
          analyser.getByteFrequencyData(data);
          const avg = data.reduce((a, b) => a + b, 0) / data.length;

          setAudioAnomaly(avg > 180);

          frame = requestAnimationFrame(loop);
        };

        loop();
      } catch (e) {
        console.error(e);
      }
    };

    setup();

    return () => cancelAnimationFrame(frame);
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