"use client";

import { useEffect, useState } from "react";

type Props = {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  enabled?: boolean;
};

let faceApiReadyPromise: Promise<typeof import("face-api.js")> | null = null;

function loadFaceApi() {
  if (!faceApiReadyPromise) {
    faceApiReadyPromise = import("face-api.js").then(async (faceapi) => {
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri("/models"),
        faceapi.nets.faceLandmark68Net.loadFromUri("/models"),
      ]);

      return faceapi;
    });
  }

  return faceApiReadyPromise;
}

export default function useCognitiveSignals({
  videoRef,
  enabled = false,
}: Props) {
  const [faceCount, setFaceCount] = useState(0);
  const [faceDetected, setFaceDetected] = useState(false);
  const [multiFace, setMultiFace] = useState(false);
  const [attention, setAttention] = useState(true);
  const [tabActive, setTabActive] = useState(true);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let interval: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    let detectionInFlight = false;

    const detect = async (faceapi: typeof import("face-api.js")) => {
      const video = videoRef.current;

      if (!video || video.readyState !== 4) {
        return;
      }
      if (detectionInFlight) return;
      detectionInFlight = true;

      try {
        const detections = await faceapi
          .detectAllFaces(
            video,
            new faceapi.TinyFaceDetectorOptions({
              inputSize: 224,
              scoreThreshold: 0.3,
            })
          )
          .withFaceLandmarks();

        if (cancelled) {
          return;
        }

        const count = detections.length;

        setFaceCount(count);
        setFaceDetected(count >= 1);
        setMultiFace(count > 1);

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
      } catch (error) {
        console.error("Face detection error:", error);
      } finally {
        detectionInFlight = false;
      }
    };

    const start = async () => {
      const faceapi = await loadFaceApi();

      if (cancelled) {
        return;
      }

      interval = setInterval(() => {
        void detect(faceapi);
      }, 2_000);
    };

    void start();

    return () => {
      cancelled = true;

      if (interval) {
        clearInterval(interval);
      }
    };
  }, [enabled, videoRef]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      setTabActive(document.visibilityState === "visible");
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  return {
    faceCount: enabled ? faceCount : 0,
    faceDetected: enabled ? faceDetected : false,
    multiFace: enabled ? multiFace : false,
    attention: enabled ? attention : true,
    tabActive,
    audioAnomaly: false,
  };
}
