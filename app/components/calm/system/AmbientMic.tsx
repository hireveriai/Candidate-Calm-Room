"use client";

import { useEffect } from "react";
import type { RefObject } from "react";

const SAMPLE_INTERVAL_MS = 250;
const REPORT_INTERVAL_MS = 10_000;
const MIN_ACTIVE_RMS = 0.01;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function standardDeviation(values: number[], average: number) {
  if (values.length < 2) return 0;

  const variance = values.reduce((total, value) => total + (value - average) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export default function AmbientMic({
  active,
  attemptId,
  videoRef,
  resetKey,
}: {
  active: boolean;
  attemptId: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  resetKey?: number;
}) {
  useEffect(() => {
    if (!active || !attemptId) return;

    const activeSamples: number[] = [];
    let context: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let samples: Float32Array<ArrayBuffer> | null = null;
    let setupTimer: ReturnType<typeof setInterval> | null = null;
    let sampleTimer: ReturnType<typeof setInterval> | null = null;
    let reportTimer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      const stream = videoRef.current?.srcObject;
      if (!(stream instanceof MediaStream) || stream.getAudioTracks().length === 0) return false;

      context = new AudioContext();
      analyser = context.createAnalyser();
      source = context.createMediaStreamSource(stream);
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.65;
      samples = new Float32Array(analyser.fftSize);
      source.connect(analyser);
      void context.resume();

      sampleTimer = setInterval(() => {
        if (!analyser || !samples) return;

        analyser.getFloatTimeDomainData(samples);
        const meanSquare = samples.reduce((total, sample) => total + sample * sample, 0) / samples.length;
        const rms = Math.sqrt(meanSquare);

        if (rms >= MIN_ACTIVE_RMS) activeSamples.push(rms);
      }, SAMPLE_INTERVAL_MS);

      reportTimer = setInterval(() => {
        if (activeSamples.length < 8) {
          activeSamples.length = 0;
          return;
        }

        const window = activeSamples.splice(0);
        const averageRms = window.reduce((total, value) => total + value, 0) / window.length;
        const variability = standardDeviation(window, averageRms);
        const score = clamp((averageRms * 3 + variability * 5) * 100, 0, 100);

        void fetch("/api/session/signal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            attemptId,
            type: "vocal_pressure",
            value: {
              score: Number((score / 100).toFixed(4)),
              averageRms: Number(averageRms.toFixed(5)),
              variability: Number(variability.toFixed(5)),
              sampleCount: window.length,
              model: "acoustic-activity-v1",
              interpretation: "experimental_non_clinical",
            },
          }),
          keepalive: true,
        }).catch(() => {
          // Interview continuity is more important than optional telemetry.
        });
      }, REPORT_INTERVAL_MS);

      return true;
    };

    if (!start()) {
      setupTimer = setInterval(() => {
        if (start() && setupTimer) {
          clearInterval(setupTimer);
          setupTimer = null;
        }
      }, 1_000);
    }

    return () => {
      if (setupTimer) clearInterval(setupTimer);
      if (sampleTimer) clearInterval(sampleTimer);
      if (reportTimer) clearInterval(reportTimer);
      source?.disconnect();
      analyser?.disconnect();
      if (context && context.state !== "closed") void context.close();
    };
  }, [active, attemptId, resetKey, videoRef]);

  return null;
}
