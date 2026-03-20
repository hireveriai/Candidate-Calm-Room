"use client";

import { useEffect, useState } from "react";
import * as faceapi from "face-api.js";

export default function useFaceDetection(videoRef: any) {
  const [faceDetected, setFaceDetected] = useState(false);
  const [attention, setAttention] = useState(true);

  useEffect(() => {
    let interval: any;

    const loadModels = async () => {
      console.log("Loading models...");
      await faceapi.nets.tinyFaceDetector.loadFromUri("/models");
      await faceapi.nets.faceLandmark68Net.loadFromUri("/models");
      console.log("Models loaded");
    };

    const detect = async () => {
      if (!videoRef.current) {
        console.log("No video ref");
        return;
      }

      if (videoRef.current.readyState !== 4) {
        console.log("Video not ready");
        return;
      }

      const result = await faceapi
        .detectSingleFace(
          videoRef.current,
          new faceapi.TinyFaceDetectorOptions()
        )
        .withFaceLandmarks();

      console.log("Detection result:", result);

      if (!result) {
        setFaceDetected(false);
        setAttention(false);
        return;
      }

      setFaceDetected(true);

      const nose = result.landmarks.getNose()[3];
      const leftEye = result.landmarks.getLeftEye()[0];
      const rightEye = result.landmarks.getRightEye()[3];

      const eyeCenterX = (leftEye.x + rightEye.x) / 2;
      const deviation = Math.abs(nose.x - eyeCenterX);

      setAttention(deviation < 25);
    };

    const start = async () => {
      await loadModels();

      interval = setInterval(detect, 1000);
    };

    start();

    return () => clearInterval(interval);
  }, [videoRef]);

  return { faceDetected, attention };
}