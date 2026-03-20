"use client";

import { useEffect, useState } from "react";
import * as faceapi from "face-api.js";

export default function useFaceDetection(videoRef: any) {
  const [faceDetected, setFaceDetected] = useState(false);
  const [attention, setAttention] = useState(true);

  useEffect(() => {
    if (!videoRef.current) return;

    let interval: any;

    const loadModels = async () => {
      await faceapi.nets.tinyFaceDetector.loadFromUri("/models");
      await faceapi.nets.faceLandmark68Net.loadFromUri("/models");
    };

    const detect = async () => {
      if (!videoRef.current) return;

      const result = await faceapi
        .detectSingleFace(
          videoRef.current,
          new faceapi.TinyFaceDetectorOptions()
        )
        .withFaceLandmarks();

      if (!result) {
        setFaceDetected(false);
        setAttention(false);
        return;
      }

      setFaceDetected(true);

      // 🧠 ATTENTION LOGIC
      const nose = result.landmarks.getNose()[3];
      const leftEye = result.landmarks.getLeftEye()[0];
      const rightEye = result.landmarks.getRightEye()[3];

      const eyeCenterX = (leftEye.x + rightEye.x) / 2;

      const deviation = Math.abs(nose.x - eyeCenterX);

      // 🎯 Threshold tuning
      if (deviation > 25) {
        setAttention(false); // looking away
      } else {
        setAttention(true); // focused
      }
    };

    const start = async () => {
      await loadModels();

      interval = setInterval(detect, 700);
    };

    start();

    return () => clearInterval(interval);
  }, [videoRef]);

  return { faceDetected, attention };
}