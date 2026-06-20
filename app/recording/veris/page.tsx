"use client";

import { useEffect, useRef, useState } from "react";
import {
  RemoteTrack,
  Room,
  RoomEvent,
  Track,
} from "livekit-client";

type InterviewContext = {
  questionText: string;
  transcript: string;
  verisState: "idle" | "listening" | "thinking" | "speaking";
};

const EMPTY_CONTEXT: InterviewContext = {
  questionText: "Preparing the interview question…",
  transcript: "",
  verisState: "thinking",
};

function getStateContent(state: InterviewContext["verisState"]) {
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

export default function VerisRecordingView() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioElementsRef = useRef<HTMLMediaElement[]>([]);
  const recordingStartedRef = useRef(false);
  const [context, setContext] = useState<InterviewContext>(EMPTY_CONTEXT);
  const stateContent = getStateContent(context.verisState);

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
      if (track.kind === Track.Kind.Video && videoRef.current) {
        track.attach(videoRef.current);
        videoRef.current.onloadeddata = beginRecording;
        return;
      }

      if (track.kind === Track.Kind.Audio) {
        const element = track.attach();
        element.autoplay = true;
        element.style.display = "none";
        document.body.appendChild(element);
        audioElementsRef.current = [...audioElementsRef.current, element];
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

          setContext({
            questionText:
              typeof message.questionText === "string" &&
              message.questionText.trim()
                ? message.questionText
                : EMPTY_CONTEXT.questionText,
            transcript:
              typeof message.transcript === "string"
                ? message.transcript
                : "",
            verisState:
              message.verisState === "speaking" ||
              message.verisState === "listening" ||
              message.verisState === "thinking" ||
              message.verisState === "idle"
                ? message.verisState
                : "thinking",
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
      audioElementsRef.current.forEach((element) => element.remove());
      audioElementsRef.current = [];
      room.disconnect();
    };
  }, []);

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[#070b12] text-white">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_80%_0%,rgba(48,92,140,0.16),transparent_36%)]" />

      <header className="relative z-10 flex h-[92px] items-center justify-between border-b border-white/10 px-12">
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

      <section className="relative z-10 grid h-[calc(100vh-92px)] grid-cols-[minmax(0,1.65fr)_minmax(420px,0.75fr)] gap-7 p-8">
        <div className="relative overflow-hidden rounded-[24px] border border-white/10 bg-black shadow-2xl">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            className="h-full w-full object-cover"
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

        <aside className="flex flex-col rounded-[24px] border border-white/10 bg-[#0d1420]/95 p-8 shadow-2xl">
          <div className="flex items-center gap-4 border-b border-white/10 pb-7">
            <div className="flex h-14 w-14 items-center justify-center rounded-full border border-sky-300/35 bg-sky-300/[0.08]">
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

          <div className="pt-8">
            <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-sky-300/65">
              Current question
            </p>
            <h1 className="mt-4 text-[26px] font-medium leading-[1.42] tracking-[-0.02em] text-slate-50">
              {context.questionText}
            </h1>
          </div>

          <div className="mt-auto border-t border-white/10 pt-7">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">
                Candidate response
              </p>
              {context.verisState === "listening" ? (
                <span className="flex items-center gap-2 text-[11px] text-emerald-300/80">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                  Speaking
                </span>
              ) : null}
            </div>
            <p className="mt-4 min-h-24 text-sm leading-7 text-slate-300">
              {context.transcript.trim() ||
                (context.verisState === "listening"
                  ? "Response transcription will appear here as the candidate speaks."
                  : "Waiting for the candidate’s response.")}
            </p>
          </div>
        </aside>
      </section>
    </main>
  );
}
