"use client";

import { useEffect, useState } from "react";

import {
  classifyAttentionDirection,
  shouldConfirmAttentionLoss,
  shouldConfirmAttentionRecovery,
  shouldConfirmMissingFace,
  type AttentionDirection,
} from "@/app/lib/faceAttentionPolicy";

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
  const [faceDetectionReady, setFaceDetectionReady] = useState(false);
  const [multiFace, setMultiFace] = useState(false);
  const [attention, setAttention] = useState(true);
  const [attentionDirection, setAttentionDirection] =
    useState<AttentionDirection>("center");
  const [tabActive, setTabActive] = useState(true);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let interval: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    let detectionInFlight = false;
    let consecutiveFaceMisses = 0;
    let consecutiveAwaySamples = 0;
    let consecutiveCenterSamples = 0;

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
        setMultiFace(count > 1);

        if (count === 1) {
          consecutiveFaceMisses = 0;
          setFaceDetected(true);
          setFaceDetectionReady(true);
          const landmarks = detections[0].landmarks;
          const nose = landmarks.getNose()[3];
          const leftEye = landmarks.getLeftEye();
          const rightEye = landmarks.getRightEye();
          const eyePoints = [...leftEye, ...rightEye];
          const eyeCenterX =
            eyePoints.reduce((sum, point) => sum + point.x, 0) /
            eyePoints.length;
          const eyeCenterY =
            eyePoints.reduce((sum, point) => sum + point.y, 0) /
            eyePoints.length;
          const direction = classifyAttentionDirection({
            faceWidth: detections[0].detection.box.width,
            faceHeight: detections[0].detection.box.height,
            noseX: nose.x,
            noseY: nose.y,
            eyeCenterX,
            eyeCenterY,
          });

          if (direction === "center") {
            consecutiveAwaySamples = 0;
            consecutiveCenterSamples += 1;
            if (shouldConfirmAttentionRecovery(consecutiveCenterSamples)) {
              setAttention(true);
              setAttentionDirection("center");
            }
          } else {
            consecutiveCenterSamples = 0;
            consecutiveAwaySamples += 1;
            if (shouldConfirmAttentionLoss(consecutiveAwaySamples)) {
              setAttention(false);
              setAttentionDirection(direction);
            }
          }
        } else if (count === 0) {
          consecutiveFaceMisses += 1;
          consecutiveAwaySamples = 0;
          consecutiveCenterSamples = 0;
          if (shouldConfirmMissingFace(consecutiveFaceMisses)) {
            setFaceDetected(false);
            setFaceDetectionReady(true);
            setAttention(true);
            setAttentionDirection("center");
          }
        } else {
          // Multiple detections still prove that the camera sees a face.
          consecutiveFaceMisses = 0;
          setFaceDetected(true);
          setFaceDetectionReady(true);
          setAttention(true);
          setAttentionDirection("center");
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
    faceDetectionReady: enabled ? faceDetectionReady : false,
    multiFace: enabled ? multiFace : false,
    attention: enabled ? attention : true,
    attentionDirection: enabled ? attentionDirection : "center",
    tabActive,
    audioAnomaly: false,
  };
}
