"use client";

import { useEffect } from "react";
import type { RefObject } from "react";

import { classifyAudioQualityWindow } from "@/app/lib/audioQualityPolicy";

const SAMPLE_INTERVAL_MS = 250;
const REPORT_INTERVAL_MS = 10_000;
const MIN_ACTIVE_RMS = 0.01;
const REQUIRED_CONSECUTIVE_WINDOWS = 2;
const SIGNAL_COOLDOWN_MS = 60_000;
// A getUserMedia audio track can resolve successfully (no permission error,
// no thrown exception) while still delivering pure silence -- e.g. the OS
// bound the granted permission to a muted or wrong input device right after
// a device switch. That case previously produced zero telemetry of any kind
// and no candidate-facing warning, so a candidate with a genuinely broken
// mic had no way to know until the interview timed out with nothing
// recorded. Three consecutive fully-silent 10s windows (30s total) is long
// enough to rule out a normal "reading the question" pause.
const REQUIRED_SILENT_WINDOWS_FOR_ALERT = 3;

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
  onSilentMicrophoneDetected,
  onMicrophoneAudioDetected,
}: {
  active: boolean;
  attemptId: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  resetKey?: number;
  onSilentMicrophoneDetected?: () => void;
  onMicrophoneAudioDetected?: () => void;
}) {
  useEffect(() => {
    if (!active || !attemptId) return;

    const activeSamples: number[] = [];
    let totalSampleCount = 0;
    let silentWindows = 0;
    let alertedSilentMicrophone = false;
    let lowVolumeWindows = 0;
    let backgroundNoiseWindows = 0;
    const lastSignalAt: Record<string, number> = {};
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

        totalSampleCount += 1;
        analyser.getFloatTimeDomainData(samples);
        const meanSquare = samples.reduce((total, sample) => total + sample * sample, 0) / samples.length;
        const rms = Math.sqrt(meanSquare);

        if (rms >= MIN_ACTIVE_RMS) activeSamples.push(rms);
      }, SAMPLE_INTERVAL_MS);

      reportTimer = setInterval(() => {
        const capturedSampleCount = totalSampleCount;
        totalSampleCount = 0;

        if (activeSamples.length < 8) {
          // Completely silent windows (not just quiet ones) are the signature
          // of a live-but-mute audio track -- e.g. the browser granted mic
          // permission but the OS bound it to a muted or disconnected input.
          // A sparse-but-nonzero window is more likely a normal brief pause.
          if (activeSamples.length === 0) {
            silentWindows += 1;
            if (silentWindows >= REQUIRED_SILENT_WINDOWS_FOR_ALERT) {
              alertedSilentMicrophone = true;
              // WarningOverlay is a transient toast that auto-dismisses on
              // its own timer, so it must be re-triggered periodically while
              // the problem persists rather than fired once and forgotten --
              // otherwise a candidate who glances away for a moment never
              // sees it again for the rest of a silent interview.
              if (silentWindows % REQUIRED_SILENT_WINDOWS_FOR_ALERT === 0) {
                onSilentMicrophoneDetected?.();
              }

              const now = Date.now();
              if (now - (lastSignalAt.no_microphone_signal ?? 0) >= SIGNAL_COOLDOWN_MS) {
                lastSignalAt.no_microphone_signal = now;
                void fetch("/api/session/signal", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    attemptId,
                    type: "no_microphone_signal",
                    value: {
                      severity: "high",
                      source: "browser_audio_quality_monitor",
                      silentWindows,
                      windowSeconds: REPORT_INTERVAL_MS / 1000,
                    },
                  }),
                  keepalive: true,
                }).catch(() => {
                  // Recording-quality reporting must never interrupt the interview.
                });
              }
            }
          } else {
            silentWindows = 0;
          }

          activeSamples.length = 0;
          lowVolumeWindows = 0;
          backgroundNoiseWindows = 0;
          return;
        }

        if (alertedSilentMicrophone) {
          alertedSilentMicrophone = false;
          onMicrophoneAudioDetected?.();
        }
        silentWindows = 0;

        const window = activeSamples.splice(0);
        const averageRms = window.reduce((total, value) => total + value, 0) / window.length;
        const variability = standardDeviation(window, averageRms);
        const activeRatio =
          capturedSampleCount > 0 ? window.length / capturedSampleCount : 0;
        const score = clamp((averageRms * 3 + variability * 5) * 100, 0, 100);
        const classification = classifyAudioQualityWindow({
          averageRms,
          variability,
          activeRatio,
          activeSampleCount: window.length,
        });

        lowVolumeWindows = classification.lowMicrophoneVolume
          ? lowVolumeWindows + 1
          : 0;
        backgroundNoiseWindows = classification.backgroundNoiseDetected
          ? backgroundNoiseWindows + 1
          : 0;

        const postSignal = (type: string, value: Record<string, unknown>) => {
          const now = Date.now();
          if (now - (lastSignalAt[type] ?? 0) < SIGNAL_COOLDOWN_MS) return;
          lastSignalAt[type] = now;

          void fetch("/api/session/signal", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              attemptId,
              type,
              value: {
                ...value,
                severity: "low",
                source: "browser_audio_quality_monitor",
              },
            }),
            keepalive: true,
          }).catch(() => {
            // Recording-quality reporting must never interrupt the interview.
          });
        };

        if (lowVolumeWindows >= REQUIRED_CONSECUTIVE_WINDOWS) {
          postSignal("low_microphone_volume", {
            averageRms: Number(averageRms.toFixed(5)),
            activeRatio: Number(activeRatio.toFixed(4)),
          });
        }

        if (backgroundNoiseWindows >= REQUIRED_CONSECUTIVE_WINDOWS) {
          postSignal("background_noise_detected", {
            averageRms: Number(averageRms.toFixed(5)),
            variability: Number(variability.toFixed(5)),
            activeRatio: Number(activeRatio.toFixed(4)),
          });
        }

        void fetch("/api/session/signal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            attemptId,
            // Internal recording-quality telemetry only. Recruiter-facing
            // applications deliberately suppress this neutral acoustic signal.
            type: "acoustic_activity",
            value: {
              score: Number((score / 100).toFixed(4)),
              averageRms: Number(averageRms.toFixed(5)),
              variability: Number(variability.toFixed(5)),
              activeRatio: Number(activeRatio.toFixed(4)),
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
  }, [
    active,
    attemptId,
    resetKey,
    videoRef,
    onSilentMicrophoneDetected,
    onMicrophoneAudioDetected,
  ]);

  return null;
}
