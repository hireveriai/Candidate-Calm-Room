"use client";

import { useEffect, useRef, useState } from "react";
import { RemoteTrack, Room, RoomEvent, Track } from "livekit-client";

type VerisState = "idle" | "listening" | "thinking" | "speaking";

type InterviewContext = {
  questionId: string;
  questionText: string;
  transcript: string;
  verisState: VerisState;
  publishedAt: number;
};

const EMPTY_CONTEXT: InterviewContext = {
  questionId: "",
  questionText: "Preparing the interview question…",
  transcript: "",
  verisState: "thinking",
  publishedAt: 0,
};

function normalizeDisplayText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function getRollingCaption(value: string, maximumLength = 320) {
  const text = normalizeDisplayText(value);

  if (text.length <= maximumLength) {
    return text;
  }

  const tail = text.slice(-maximumLength);
  const firstWordBoundary = tail.indexOf(" ");
  return `…${tail.slice(firstWordBoundary > -1 ? firstWordBoundary + 1 : 0)}`;
}

function getStateContent(state: VerisState) {
  if (state === "speaking") {
    return {
      title: "VERIS is asking",
      subtitle: "The candidate is listening",
      color: "text-sky-200",
    };
  }

  if (state === "listening") {
    return {
      title: "Candidate response",
      subtitle: "VERIS is listening",
      color: "text-emerald-200",
    };
  }

  return {
    title: "Interview in progress",
    subtitle: "Preparing the next step",
    color: "text-slate-200",
  };
}

function isVerisState(value: unknown): value is VerisState {
  return (
    value === "speaking" ||
    value === "listening" ||
    value === "thinking" ||
    value === "idle"
  );
}

export default function VerisRecordingView() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const recordingStartedRef = useRef(false);
  const latestContextAtRef = useRef(0);
  const [context, setContext] = useState<InterviewContext>(EMPTY_CONTEXT);
  const stateContent = getStateContent(context.verisState);
  const responseCaption = getRollingCaption(context.transcript);

  useEffect(() => {
    if (
      context.verisState !== "speaking" ||
      !context.questionText.trim() ||
      !window.speechSynthesis
    ) {
      return;
    }

    const utterance = new SpeechSynthesisUtterance(context.questionText);
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.volume = 1;

    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);

    return () => {
      window.speechSynthesis.cancel();
    };
  }, [context.questionText, context.verisState]);

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const liveKitUrl = searchParams.get("url");
    const token = searchParams.get("token");
    const localPreview =
      searchParams.get("preview") === "1" &&
      (window.location.hostname === "localhost" ||
        window.location.hostname === "127.0.0.1");

    if (localPreview) {
      setContext({
        questionId: "preview-question",
        questionText:
          "What would you do if two senior engineers proposed conflicting database designs for a business-critical platform migration?",
        transcript:
          "I would first clarify the business constraints and the measurable trade-offs behind each proposal. Then I would ask both engineers to compare reliability, migration risk, operating cost, and rollback strategy using the same decision framework.",
        verisState: "listening",
        publishedAt: Date.now(),
      });
      return;
    }

    if (!liveKitUrl || !token) {
      console.error("Recording view is missing LiveKit connection details");
      return;
    }

    const room = new Room({
      adaptiveStream: false,
      dynacast: false,
    });

    const beginRecording = () => {
      if (recordingStartedRef.current) {
        return;
      }

      recordingStartedRef.current = true;
      console.log("START_RECORDING");
    };

    const attachTrack = (track: RemoteTrack) => {
      const mediaElement = videoRef.current;

      if (!mediaElement) {
        return;
      }

      if (
        track.kind === Track.Kind.Video ||
        track.kind === Track.Kind.Audio
      ) {
        track.attach(mediaElement);
        mediaElement.autoplay = true;
        mediaElement.muted = false;

        if (track.kind === Track.Kind.Video) {
          mediaElement.onloadeddata = beginRecording;
        }
      }
    };

    room.on(RoomEvent.TrackSubscribed, attachTrack);
    room.on(
      RoomEvent.DataReceived,
      (payload, _participant, _kind, topic) => {
        if (topic !== "veris-interview-context") {
          return;
        }

        try {
          const message = JSON.parse(
            new TextDecoder().decode(payload),
          ) as Partial<InterviewContext> & { type?: string };

          if (message.type !== "veris.interview_context") {
            return;
          }

          const publishedAt =
            typeof message.publishedAt === "number"
              ? message.publishedAt
              : Date.now();

          if (publishedAt < latestContextAtRef.current) {
            return;
          }

          latestContextAtRef.current = publishedAt;
          setContext((previous) => {
            const questionId =
              typeof message.questionId === "string"
                ? message.questionId
                : previous.questionId;
            const questionChanged =
              Boolean(questionId) && questionId !== previous.questionId;
            const verisState = isVerisState(message.verisState)
              ? message.verisState
              : "thinking";
            const questionText =
              typeof message.questionText === "string" &&
              message.questionText.trim()
                ? normalizeDisplayText(message.questionText)
                : previous.questionText;
            const transcript =
              verisState === "listening" &&
              typeof message.transcript === "string"
                ? normalizeDisplayText(message.transcript)
                : "";

            return {
              questionId,
              questionText,
              transcript: questionChanged && verisState !== "listening"
                ? ""
                : transcript,
              verisState,
              publishedAt,
            };
          });
        } catch (error) {
          console.warn("Unable to parse interview recording context", error);
        }
      },
    );

    void room
      .connect(liveKitUrl, token, {
        autoSubscribe: true,
      })
      .then(() => {
        window.setTimeout(beginRecording, 1_000);
      })
      .catch((error) => {
        console.error("Unable to connect recording view", error);
      });

    return () => {
      console.log("END_RECORDING");
      room.disconnect();
    };
  }, []);

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[#070b12] text-white">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_80%_0%,rgba(48,92,140,0.16),transparent_36%)]" />

      <header className="relative z-10 flex h-[76px] items-center justify-between border-b border-white/10 px-10">
        <div className="flex items-center gap-4">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-sky-300/20 bg-sky-300/[0.08] text-xs font-semibold">
            HV
          </div>
          <div>
            <p className="text-sm font-semibold tracking-[0.22em]">VERIS</p>
            <p className="mt-1 text-xs text-slate-500">
              Structured candidate interview
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span className="h-2 w-2 rounded-full bg-red-400" />
          Recorded interview
        </div>
      </header>

      <section className="relative z-10 grid h-[calc(100vh-76px)] grid-cols-[minmax(0,1.45fr)_minmax(380px,0.8fr)] gap-5 p-6">
        <div className="relative flex min-h-0 items-center justify-center overflow-hidden rounded-[22px] border border-white/10 bg-[#030507] shadow-2xl">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            className="h-full w-full object-contain"
          />
          <div className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-white/[0.06]" />
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/35 to-transparent px-7 pb-6 pt-28">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              <span className="text-sm font-medium">Candidate</span>
            </div>
            <p className="mt-2 text-xs text-white/55">
              Live interview response
            </p>
          </div>
        </div>

        <aside className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_170px] overflow-hidden rounded-[22px] border border-white/10 bg-[#0d1420]/95 p-7 shadow-2xl">
          <div className="flex items-center gap-4 border-b border-white/10 pb-5">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-sky-300/35 bg-sky-300/[0.08]">
              <span className="h-2.5 w-2.5 rounded-full bg-sky-300 shadow-[0_0_16px_rgba(125,211,252,0.75)]" />
            </div>
            <div>
              <p className={`text-base font-semibold ${stateContent.color}`}>
                {stateContent.title}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {stateContent.subtitle}
              </p>
            </div>
          </div>

          <div className="min-h-0 overflow-hidden pt-6">
            <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-sky-300/65">
              Current question
            </p>
            <h1 className="mt-3 overflow-hidden text-[22px] font-medium leading-[1.35] tracking-[-0.02em] text-slate-50 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:6]">
              {context.questionText}
            </h1>
          </div>

          <div className="min-h-0 overflow-hidden border-t border-white/10 pt-5">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">
                Candidate response
              </p>
              {context.verisState === "listening" ? (
                <span className="flex items-center gap-2 text-[11px] text-emerald-300/80">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                  Live
                </span>
              ) : null}
            </div>
            <p className="mt-3 overflow-hidden text-sm leading-[1.55] text-slate-300 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:5]">
              {responseCaption ||
                (context.verisState === "listening"
                  ? "Listening… the candidate’s words will appear here."
                  : "Waiting for the candidate’s response.")}
            </p>
          </div>
        </aside>
      </section>
    </main>
  );
}
