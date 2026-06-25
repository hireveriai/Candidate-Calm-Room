"use client";

import { useEffect, useRef } from "react";
import { Room, Track } from "livekit-client";
import type { RefObject } from "react";

type RecordingSignal = {
  id: string;
  type: string;
  label: string;
  severity: "low" | "medium" | "high";
  occurredAt: number;
  recordingOffsetMs: number;
};

type Props = {
  attemptId?: string;
  timeLeft?: number;
  reconnectKey?: number;
  sessionQuestionId?: string;
  questionText?: string;
  transcript?: string;
  verisState?: "idle" | "listening" | "thinking" | "speaking";
  recordingSignal?: RecordingSignal | null;
  onVideoReady?: (ref: RefObject<HTMLVideoElement | null>) => void;
  onRecordingStarted?: (startedAt: number) => void;
  onRecordingFinalizerChange?: (finalize: (() => Promise<void>) | null) => void;
  onCameraStatusChange?: (ready: boolean) => void;
  onRoomConnectionChange?: (
    state: "connected" | "reconnecting" | "disconnected"
  ) => void;
};

type StartRecordingResponse = {
  egressId?: string;
  filePath?: string | null;
  videoUrl?: string | null;
  status?: string | null;
  skipped?: boolean;
  reason?: string;
  error?: string;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidAttemptId(value: string | null | undefined): value is string {
  return Boolean(value && uuidPattern.test(value.trim()));
}

async function fetchLiveKitPublisherToken(attemptId: string) {
  const searchParams = new URLSearchParams({
    room: attemptId,
    userId: `candidate-publisher-${attemptId}`,
    role: "publisher",
  });

  const response = await fetch(`/api/livekit/token?${searchParams.toString()}`);

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;

    throw new Error(payload?.error ?? "Failed to fetch LiveKit token");
  }

  const payload = (await response.json()) as { token: string };
  return payload.token;
}

async function fetchLiveKitBrowserUrl() {
  const configured = process.env.NEXT_PUBLIC_LIVEKIT_URL;

  if (configured) {
    return configured;
  }

  const response = await fetch("/api/livekit/config", {
    cache: "no-store",
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;

    throw new Error(payload?.error ?? "Failed to load LiveKit configuration");
  }

  const payload = (await response.json()) as { liveKitUrl?: string };

  if (!payload.liveKitUrl) {
    throw new Error("LiveKit URL is missing from configuration");
  }

  return payload.liveKitUrl;
}

function getBrowserRecordingMimeType() {
  if (typeof MediaRecorder === "undefined") {
    return null;
  }

  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ];

  return (
    candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ??
    null
  );
}

async function uploadBrowserRecording(params: {
  attemptId: string;
  blob: Blob;
  mimeType: string;
}) {
  const prepareResponse = await fetch(
    "/api/livekit/browser-recording/prepare-upload",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        attemptId: params.attemptId,
        mimeType: params.mimeType,
      }),
    },
  );
  const prepared = (await prepareResponse.json().catch(() => null)) as
    | {
        recordingId?: string;
        uploadUrl?: string;
        filePath?: string;
        contentType?: string;
        error?: string;
      }
    | null;

  if (!prepareResponse.ok || !prepared?.recordingId || !prepared.uploadUrl || !prepared.filePath) {
    throw new Error(prepared?.error ?? "Unable to prepare browser recording upload");
  }

  const uploadResponse = await fetch(prepared.uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": prepared.contentType ?? params.mimeType,
    },
    body: params.blob,
  });

  if (!uploadResponse.ok) {
    throw new Error((await uploadResponse.text()) || "Browser recording upload failed");
  }

  const completeResponse = await fetch(
    "/api/livekit/browser-recording/complete-upload",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        attemptId: params.attemptId,
        recordingId: prepared.recordingId,
        filePath: prepared.filePath,
        sizeBytes: params.blob.size,
      }),
    },
  );
  const completed = (await completeResponse.json().catch(() => null)) as
    | { success?: boolean; error?: string }
    | null;

  if (!completeResponse.ok || !completed?.success) {
    throw new Error(completed?.error ?? "Unable to finalize browser recording upload");
  }
}

export default function VideoPanel({
  attemptId,
  timeLeft,
  reconnectKey = 0,
  sessionQuestionId = "",
  questionText = "",
  transcript = "",
  verisState = "idle",
  recordingSignal = null,
  onVideoReady,
  onRecordingStarted,
  onRecordingFinalizerChange,
  onCameraStatusChange,
  onRoomConnectionChange,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const onVideoReadyRef = useRef(onVideoReady);
  const onRecordingStartedRef = useRef(onRecordingStarted);
  const onRecordingFinalizerChangeRef = useRef(onRecordingFinalizerChange);
  const onCameraStatusChangeRef = useRef(onCameraStatusChange);
  const onRoomConnectionChangeRef = useRef(onRoomConnectionChange);
  const hasConnectedRoomRef = useRef(false);
  const roomRef = useRef<Room | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const stopRequestedRef = useRef(false);
  const browserRecorderRef = useRef<MediaRecorder | null>(null);
  const browserRecordingChunksRef = useRef<Blob[]>([]);
  const browserRecordingMimeTypeRef = useRef<string | null>(null);
  const browserRecordingUploadRef = useRef<Promise<void> | null>(null);
  const browserRecordingStartedRef = useRef(false);
  const recordingStartedNotifiedRef = useRef(false);
  const serverRecordingEgressIdRef = useRef<string | null>(null);
  const serverRecordingStartedRef = useRef(false);
  const recordingContextRef = useRef({
    questionId: sessionQuestionId,
    questionText,
    transcript,
    verisState,
    signal: recordingSignal,
  });
  const elapsedSeconds = timeLeft ?? 0;
  const minutes = Math.floor(elapsedSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (elapsedSeconds % 60).toString().padStart(2, "0");

  useEffect(() => {
    recordingContextRef.current = {
      questionId: sessionQuestionId,
      questionText,
      transcript,
      verisState,
      signal: recordingSignal,
    };

    const room = roomRef.current;
    if (!room || !hasConnectedRoomRef.current) {
      return;
    }

    const payload = new TextEncoder().encode(
      JSON.stringify({
        type: "veris.interview_context",
        publishedAt: Date.now(),
        ...recordingContextRef.current,
      }),
    );

    void room.localParticipant
      .publishData(payload, {
        reliable: true,
        topic: "veris-interview-context",
      })
      .catch((error) => {
        console.warn("Unable to update recording context:", error);
      });
  }, [
    questionText,
    recordingSignal,
    sessionQuestionId,
    transcript,
    verisState,
  ]);

  useEffect(() => {
    onVideoReadyRef.current = onVideoReady;
  }, [onVideoReady]);

  useEffect(() => {
    onRecordingStartedRef.current = onRecordingStarted;
  }, [onRecordingStarted]);

  useEffect(() => {
    onRecordingFinalizerChangeRef.current = onRecordingFinalizerChange;
  }, [onRecordingFinalizerChange]);

  useEffect(() => {
    onCameraStatusChangeRef.current = onCameraStatusChange;
  }, [onCameraStatusChange]);

  useEffect(() => {
    onRoomConnectionChangeRef.current = onRoomConnectionChange;
  }, [onRoomConnectionChange]);

  useEffect(() => {
    const videoElement = videoRef.current;

    async function startCamera() {
      try {
        let stream: MediaStream;

        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              width: { ideal: 1280 },
              height: { ideal: 720 },
              frameRate: { ideal: 30, max: 30 },
            },
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
              channelCount: 1,
            },
          });
        } catch (combinedMediaError) {
          console.warn(
            "Microphone was unavailable; retrying camera-only preview:",
            combinedMediaError,
          );
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          });
        }

        cameraStreamRef.current = stream;

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.style.filter = "brightness(0.85) contrast(1.1)";

          videoRef.current.onloadedmetadata = () => {
            console.log("Video ready");

            if (onVideoReadyRef.current) {
              onVideoReadyRef.current(videoRef);
            }
          };
        }

        onCameraStatusChangeRef.current?.(true);
      } catch (err) {
        console.error("Camera error:", err);
        onCameraStatusChangeRef.current?.(false);
      }
    }

    startCamera();

    return () => {
      if (videoElement) {
        videoElement.srcObject = null;
      }

      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
      onCameraStatusChangeRef.current?.(false);
    };
  }, [reconnectKey]);

  useEffect(() => {
    if (!isValidAttemptId(attemptId)) {
      return;
    }

    let cancelled = false;
    const room = new Room();
    roomRef.current = room;
    let contextTimer: ReturnType<typeof setInterval> | null = null;
    stopRequestedRef.current = false;
    recordingStartedNotifiedRef.current = false;
    serverRecordingEgressIdRef.current = null;
    serverRecordingStartedRef.current = false;

    function notifyRecordingStarted() {
      if (recordingStartedNotifiedRef.current) {
        return;
      }

      recordingStartedNotifiedRef.current = true;
      onRecordingStartedRef.current?.(Date.now());
    }

    function ensureBrowserRecordingStarted(stream: MediaStream, safeAttemptId: string) {
      if (
        browserRecordingStartedRef.current ||
        browserRecorderRef.current ||
        !isValidAttemptId(safeAttemptId)
      ) {
        return;
      }

      const mimeType = getBrowserRecordingMimeType();
      if (!mimeType) {
        console.warn("Browser MediaRecorder is unavailable; LiveKit egress only.");
        return;
      }

      try {
        const recorder = new MediaRecorder(stream, { mimeType });
        browserRecordingChunksRef.current = [];
        browserRecordingMimeTypeRef.current = mimeType.split(";")[0] ?? "video/webm";
        browserRecorderRef.current = recorder;
        browserRecordingStartedRef.current = true;

        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            browserRecordingChunksRef.current.push(event.data);
          }
        };

        recorder.onerror = (event) => {
          console.error("Browser recording failed:", event);
        };

        recorder.start(5_000);
        notifyRecordingStarted();
      } catch (error) {
        browserRecorderRef.current = null;
        browserRecordingStartedRef.current = false;
        console.error("Unable to start browser recording fallback:", error);
      }
    }

    function discardBrowserRecordingChunks() {
      browserRecordingChunksRef.current = [];
      browserRecordingMimeTypeRef.current = null;
    }

    async function stopBrowserRecordingAndUpload(options: {
      restartStream?: MediaStream;
      restartAttemptId?: string;
      upload?: boolean;
    } = {}) {
      const safeAttemptId = attemptId?.trim();
      if (!isValidAttemptId(safeAttemptId)) {
        return;
      }

      if (browserRecordingUploadRef.current) {
        await browserRecordingUploadRef.current;
      }

      const recorder = browserRecorderRef.current;
      const mimeType = browserRecordingMimeTypeRef.current ?? "video/webm";

      const upload = new Promise<void>((resolve) => {
        const uploadChunks = async () => {
          const chunks = browserRecordingChunksRef.current;
          browserRecorderRef.current = null;
          browserRecordingStartedRef.current = false;

          if (options.upload === false) {
            resolve();
            return;
          }

          if (!chunks.length) {
            discardBrowserRecordingChunks();
            resolve();
            return;
          }

          try {
            await uploadBrowserRecording({
              attemptId: safeAttemptId,
              blob: new Blob(chunks, { type: mimeType }),
              mimeType,
            });
          } catch (error) {
            console.error("Unable to upload browser recording fallback:", error);
          } finally {
            discardBrowserRecordingChunks();
            if (options.restartStream && isValidAttemptId(options.restartAttemptId)) {
              ensureBrowserRecordingStarted(
                options.restartStream,
                options.restartAttemptId,
              );
            }
            resolve();
          }
        };

        if (!recorder || recorder.state === "inactive") {
          void uploadChunks();
          return;
        }

        recorder.onstop = () => {
          void uploadChunks();
        };

        try {
          recorder.requestData();
          recorder.stop();
        } catch (error) {
          console.error("Unable to stop browser recording fallback:", error);
          void uploadChunks();
        }
      });

      browserRecordingUploadRef.current = upload;
      await upload;
      browserRecordingUploadRef.current = null;
    }

    async function publishRecordingContext() {
      const payload = new TextEncoder().encode(
        JSON.stringify({
          type: "veris.interview_context",
          publishedAt: Date.now(),
          ...recordingContextRef.current,
        }),
      );

      await room.localParticipant.publishData(payload, {
        reliable: true,
        topic: "veris-interview-context",
      });
    }

    async function startServerRecording(safeAttemptId: string) {
      if (
        serverRecordingStartedRef.current ||
        serverRecordingEgressIdRef.current ||
        !isValidAttemptId(safeAttemptId)
      ) {
        return;
      }

      const response = await fetch("/api/livekit/start-recording", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ attemptId: safeAttemptId }),
      });
      const payload = (await response.json().catch(() => null)) as
        | StartRecordingResponse
        | null;

      if (!response.ok) {
        throw new Error(payload?.error ?? "Unable to start LiveKit recording");
      }

      if (!payload?.egressId) {
        console.warn(
          "LiveKit recording was not started:",
          payload?.reason ?? "missing egress id",
        );
        return;
      }

      serverRecordingEgressIdRef.current = payload.egressId;
      serverRecordingStartedRef.current = true;
      notifyRecordingStarted();
    }

    async function stopServerRecording() {
      const egressId = serverRecordingEgressIdRef.current;
      if (!egressId) {
        return;
      }

      serverRecordingEgressIdRef.current = null;
      serverRecordingStartedRef.current = false;

      const response = await fetch("/api/livekit/stop-recording", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ egressId }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(payload?.error ?? "Unable to stop LiveKit recording");
      }
    }

    async function ensureRecordingStopped() {
      if (stopRequestedRef.current) {
        return;
      }

      stopRequestedRef.current = true;
      const hadServerRecording = Boolean(serverRecordingEgressIdRef.current);
      await stopBrowserRecordingAndUpload({ upload: false });

      if (!hadServerRecording) {
        await stopBrowserRecordingAndUpload();
        return;
      }

      try {
        await stopServerRecording();
        discardBrowserRecordingChunks();
      } catch (error) {
        console.error("Unable to finalize LiveKit recording:", error);
        await stopBrowserRecordingAndUpload();
      }
    }

    onRecordingFinalizerChangeRef.current?.(ensureRecordingStopped);

    async function publishCamera() {
      try {
        const safeAttemptId = attemptId?.trim();

        if (!isValidAttemptId(safeAttemptId)) {
          return;
        }

        const stream =
          cameraStreamRef.current ??
          (await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
              channelCount: 1,
            },
          }));

        cameraStreamRef.current = stream;
        ensureBrowserRecordingStarted(stream, safeAttemptId);

        const [liveKitUrl, token] = await Promise.all([
          fetchLiveKitBrowserUrl(),
          fetchLiveKitPublisherToken(safeAttemptId),
        ]);

        await room.connect(liveKitUrl, token);
        hasConnectedRoomRef.current = true;
        onRoomConnectionChangeRef.current?.("connected");

        if (cancelled) {
          room.disconnect();
          return;
        }

        const [videoTrack] = stream.getVideoTracks();

        if (!videoTrack) {
          throw new Error("Camera track is not available");
        }

        await room.localParticipant.publishTrack(videoTrack, {
          source: Track.Source.Camera,
        });

        const [audioTrack] = stream.getAudioTracks();
        if (audioTrack) {
          await room.localParticipant.publishTrack(audioTrack, {
            source: Track.Source.Microphone,
          });
        } else {
          console.warn(
            "Microphone track is unavailable; continuing with video-only recording.",
          );
        }

        await publishRecordingContext().catch((error) => {
          console.warn("Unable to publish initial recording context:", error);
        });

        await startServerRecording(safeAttemptId).catch((error) => {
          console.error("Unable to start LiveKit egress recording:", error);
        });

        contextTimer = setInterval(() => {
          void publishRecordingContext().catch((error) => {
            console.warn("Unable to refresh recording context:", error);
          });
        }, 2_000);

      } catch (error) {
        console.error("Unable to publish LiveKit camera feed:", error);
        onRoomConnectionChangeRef.current?.("disconnected");
      }
    }

    room.on("reconnecting", () => {
      if (hasConnectedRoomRef.current) {
        onRoomConnectionChangeRef.current?.("reconnecting");
      }
    });
    room.on("reconnected", () => {
      hasConnectedRoomRef.current = true;
      onRoomConnectionChangeRef.current?.("connected");
    });
    room.on("disconnected", () => {
      if (hasConnectedRoomRef.current) {
        onRoomConnectionChangeRef.current?.("disconnected");
      }
    });

    void publishCamera();

    return () => {
      cancelled = true;
      if (contextTimer) {
        clearInterval(contextTimer);
      }
      void ensureRecordingStopped();
      onRecordingFinalizerChangeRef.current?.(null);
      room.disconnect();
      roomRef.current = null;
      hasConnectedRoomRef.current = false;
    };
  }, [attemptId, reconnectKey]);

  return (
    <section className="overflow-hidden rounded-[20px] border border-white/[0.11] bg-[#0c121d] shadow-[0_24px_70px_rgba(0,0,0,0.3)]">
      <div className="flex h-12 items-center justify-between border-b border-white/[0.07] px-4 sm:px-5">
        <div className="flex items-center gap-2.5">
          <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.45)]" />
          <span className="text-xs font-medium text-slate-200">Candidate camera</span>
        </div>
        <span className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
          Live preview
        </span>
      </div>

      <div className="relative aspect-video w-full overflow-hidden bg-[#05080d]">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="h-full w-full object-cover"
        />

        <div className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-white/[0.06]" />
        <div className="absolute left-4 top-4 flex items-center gap-2 rounded-md border border-white/10 bg-[#080b10]/80 px-2.5 py-1.5 backdrop-blur-md">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400/60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-red-400" />
          </span>
          <span className="text-[10px] font-medium uppercase tracking-[0.15em] text-slate-300">
            Recording
          </span>
          <span className="border-l border-white/10 pl-2 font-mono text-[11px] tabular-nums text-white/75">
            {minutes}:{seconds}
          </span>
        </div>

        <div className="absolute inset-x-0 bottom-0 flex items-end justify-between bg-gradient-to-t from-black/55 to-transparent px-4 pb-3 pt-12">
          <span className="text-[11px] text-white/65">
            Keep your face centered and well lit
          </span>
          <span className="rounded bg-black/35 px-2 py-1 text-[10px] text-white/55 backdrop-blur-sm">
            You
          </span>
        </div>
      </div>
    </section>
  );
}
