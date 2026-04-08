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
  const [audioAnomaly, setAudioAnomaly] = useState(false);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let interval: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    const detect = async (faceapi: typeof import("face-api.js")) => {
      const video = videoRef.current;

      if (!video || video.readyState !== 4) {
        return;
      }

      try {
        const detections = await faceapi
          .detectAllFaces(
            video,
            new faceapi.TinyFaceDetectorOptions({
              inputSize: 320,
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
      }
    };

    const start = async () => {
      const faceapi = await loadFaceApi();

      if (cancelled) {
        return;
      }

      interval = setInterval(() => {
        void detect(faceapi);
      }, 1_200);
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

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let frame = 0;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let cancelled = false;

    const setup = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();

        analyser.fftSize = 256;
        src.connect(analyser);

        const data = new Uint8Array(analyser.frequencyBinCount);

        const loop = () => {
          if (cancelled) {
            return;
          }

          analyser.getByteFrequencyData(data);
          const avg = data.reduce((sum, value) => sum + value, 0) / data.length;

          setAudioAnomaly(avg > 180);
          frame = requestAnimationFrame(loop);
        };

        loop();
      } catch (error) {
        console.error(error);
      }
    };

    void setup();

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());

      if (ctx && ctx.state !== "closed") {
        void ctx.close();
      }
    };
  }, [enabled]);

  return {
    faceCount: enabled ? faceCount : 0,
    faceDetected: enabled ? faceDetected : false,
    multiFace: enabled ? multiFace : false,
    attention: enabled ? attention : true,
    tabActive,
    audioAnomaly: enabled ? audioAnomaly : false,
  };
}
