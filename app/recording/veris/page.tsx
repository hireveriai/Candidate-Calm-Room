"use client";

import { useEffect, useRef, useState } from "react";
import { RemoteTrack, Room, RoomEvent, Track } from "livekit-client";

type VerisState = "idle" | "listening" | "thinking" | "speaking";

type RecordingSignal = {
  id: string;
  type: string;
  label: string;
  severity: "low" | "medium" | "high";
  occurredAt: number;
  recordingOffsetMs: number;
};

type InterviewContext = {
  questionId: string;
  questionText: string;
  transcript: string;
  verisState: VerisState;
  publishedAt: number;
  signal: RecordingSignal | null;
};

type QuestionTrailItem = {
  id: string;
  text: string;
  state: VerisState;
  at: number;
};

type TranscriptTrailItem = {
  questionId: string;
  text: string;
  at: number;
};

const EMPTY_CONTEXT: InterviewContext = {
  questionId: "",
  questionText: "Preparing the interview question...",
  transcript: "",
  verisState: "thinking",
  publishedAt: 0,
  signal: null,
};

const PREVIEW_CONTEXT: InterviewContext = {
  questionId: "preview-question",
  questionText:
    "What would you do if two senior engineers proposed conflicting database designs for a business-critical platform migration?",
  transcript:
    "I would first clarify the business constraints and measurable trade-offs behind each proposal. Then I would ask both engineers to compare reliability, migration risk, operating cost, and rollback strategy using the same decision framework.",
  verisState: "listening",
  publishedAt: 0,
  signal: {
    id: "preview-signal",
    type: "attention_loss",
    label: "Attention shifted",
    severity: "low",
    occurredAt: 0,
    recordingOffsetMs: 272_000,
  },
};

function normalizeDisplayText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function getRollingCaption(value: string, maximumLength = 340) {
  const text = normalizeDisplayText(value);

  if (text.length <= maximumLength) {
    return text;
  }

  const tail = text.slice(-maximumLength);
  const firstWordBoundary = tail.indexOf(" ");
  return `...${tail.slice(firstWordBoundary > -1 ? firstWordBoundary + 1 : 0)}`;
}

function getStateContent(state: VerisState) {
  if (state === "speaking") {
    return {
      title: "VERIS is asking",
      subtitle: "Candidate is listening",
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

function formatOffset(ms: number) {
  const safeMs = Math.max(0, Math.round(ms || 0));
  const totalSeconds = Math.floor(safeMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");

  return `${minutes}:${seconds}`;
}

function severityClass(severity: RecordingSignal["severity"]) {
  if (severity === "high") {
    return {
      dot: "bg-red-400",
      border: "border-red-300/30",
      text: "text-red-100",
      bg: "bg-red-500/10",
    };
  }

  if (severity === "medium") {
    return {
      dot: "bg-amber-300",
      border: "border-amber-300/30",
      text: "text-amber-100",
      bg: "bg-amber-400/10",
    };
  }

  return {
    dot: "bg-sky-300",
    border: "border-sky-300/25",
    text: "text-sky-100",
    bg: "bg-sky-400/10",
  };
}

function normalizeSignal(
  signal: RecordingSignal,
  recordingStartedAt: number,
  offsets: Map<string, number>,
) {
  if (!recordingStartedAt) {
    return signal;
  }

  const existingOffset = offsets.get(signal.id);
  const recordingOffsetMs =
    existingOffset ?? Math.max(0, Date.now() - recordingStartedAt);

  offsets.set(signal.id, recordingOffsetMs);

  return {
    ...signal,
    recordingOffsetMs,
  };
}

export default function VerisRecordingView() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const recordingStartedRef = useRef(false);
  const recordingStartedAtRef = useRef(0);
  const signalOffsetsRef = useRef(new Map<string, number>());
  const latestContextAtRef = useRef(0);
  const [context, setContext] = useState<InterviewContext>(EMPTY_CONTEXT);
  const [questionTrail, setQuestionTrail] = useState<QuestionTrailItem[]>([]);
  const [transcriptTrail, setTranscriptTrail] = useState<TranscriptTrailItem[]>(
    [],
  );
  const [signalTrail, setSignalTrail] = useState<RecordingSignal[]>([]);
  const stateContent = getStateContent(context.verisState);
  const responseCaption = getRollingCaption(context.transcript);
  const latestQuestions = questionTrail.slice(-4).reverse();
  const latestSignals = signalTrail.slice(-5).reverse();
  const transcriptHistory = transcriptTrail.slice(-3).reverse();
  const currentSeverity = context.signal
    ? severityClass(context.signal.severity)
    : null;

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
      const frame = window.requestAnimationFrame(() => {
        const now = Date.now();
        const previewSignal = PREVIEW_CONTEXT.signal
          ? {
              ...PREVIEW_CONTEXT.signal,
              occurredAt: now,
            }
          : null;

        setContext({
          ...PREVIEW_CONTEXT,
          publishedAt: now,
          signal: previewSignal,
        });
        setQuestionTrail([
          {
            id: PREVIEW_CONTEXT.questionId,
            text: PREVIEW_CONTEXT.questionText,
            state: PREVIEW_CONTEXT.verisState,
            at: now,
          },
        ]);
        setTranscriptTrail([
          {
            questionId: PREVIEW_CONTEXT.questionId,
            text: PREVIEW_CONTEXT.transcript,
            at: now,
          },
        ]);
        setSignalTrail(previewSignal ? [previewSignal] : []);
      });

      return () => window.cancelAnimationFrame(frame);
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
      recordingStartedAtRef.current = Date.now();
      console.log("START_RECORDING");
    };

    const attachTrack = (track: RemoteTrack) => {
      const mediaElement = videoRef.current;

      if (!mediaElement) {
        return;
      }

      if (track.kind === Track.Kind.Video || track.kind === Track.Kind.Audio) {
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

          const questionId =
            typeof message.questionId === "string" ? message.questionId : "";
          const messageQuestion =
            typeof message.questionText === "string" &&
            message.questionText.trim()
              ? normalizeDisplayText(message.questionText)
              : "";
          const verisState = isVerisState(message.verisState)
            ? message.verisState
            : "thinking";
          const messageTranscript =
            typeof message.transcript === "string" && message.transcript.trim()
              ? normalizeDisplayText(message.transcript)
              : "";
          const incomingSignal =
            message.signal &&
            typeof message.signal === "object" &&
            typeof message.signal.id === "string" &&
            typeof message.signal.label === "string"
              ? normalizeSignal(
                  message.signal,
                  recordingStartedAtRef.current,
                  signalOffsetsRef.current,
                )
              : null;

          if (questionId && messageQuestion) {
            setQuestionTrail((previous) => {
              const withoutCurrent = previous.filter(
                (item) => item.id !== questionId,
              );

              return [
                ...withoutCurrent,
                {
                  id: questionId,
                  text: messageQuestion,
                  state: verisState,
                  at: publishedAt,
                },
              ].slice(-12);
            });
          }

          if (questionId && messageTranscript) {
            setTranscriptTrail((previous) => {
              const withoutCurrent = previous.filter(
                (item) => item.questionId !== questionId,
              );

              return [
                ...withoutCurrent,
                {
                  questionId,
                  text: messageTranscript,
                  at: publishedAt,
                },
              ].slice(-12);
            });
          }

          if (incomingSignal) {
            setSignalTrail((previous) => {
              if (previous.some((signal) => signal.id === incomingSignal.id)) {
                return previous;
              }

              return [...previous, incomingSignal].slice(-20);
            });
          }

          setContext((previous) => {
            const resolvedQuestionId = questionId || previous.questionId;
            const questionChanged =
              Boolean(resolvedQuestionId) &&
              resolvedQuestionId !== previous.questionId;
            const questionText = messageQuestion || previous.questionText;
            const transcript =
              verisState === "listening" ? messageTranscript : "";

            return {
              questionId: resolvedQuestionId,
              questionText,
              transcript:
                questionChanged && verisState !== "listening"
                  ? ""
                  : transcript,
              verisState,
              publishedAt,
              signal: incomingSignal,
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

      <header className="relative z-10 flex h-[78px] items-center justify-between border-b border-white/10 px-10">
        <div className="flex items-center gap-4">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-sky-300/20 bg-sky-300/[0.08] text-xs font-semibold">
            HV
          </div>
          <div>
            <p className="text-sm font-semibold tracking-[0.22em]">VERIS</p>
            <p className="mt-1 text-xs text-slate-500">
              Enterprise interview evidence
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4 text-xs text-slate-400">
          <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-2">
            <span className="h-2 w-2 rounded-full bg-red-400" />
            Recording MP4
          </div>
          <div className="rounded-full border border-sky-300/20 bg-sky-300/[0.06] px-3 py-2 text-sky-100">
            {questionTrail.length} VERIS prompts
          </div>
          <div className="rounded-full border border-amber-300/20 bg-amber-300/[0.06] px-3 py-2 text-amber-100">
            {signalTrail.length} risk signals
          </div>
        </div>
      </header>

      <section className="relative z-10 grid h-[calc(100vh-78px)] grid-cols-[minmax(0,1.38fr)_minmax(410px,0.72fr)] gap-5 p-6">
        <div className="relative flex min-h-0 items-center justify-center overflow-hidden rounded-[20px] border border-white/10 bg-[#030507] shadow-2xl">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            className="h-full w-full object-contain"
          />
          <div className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-white/[0.06]" />

          {context.signal && currentSeverity ? (
            <div
              className={`absolute left-6 top-6 flex max-w-[360px] items-center gap-3 rounded-xl border px-4 py-3 shadow-[0_16px_45px_rgba(0,0,0,0.35)] ${currentSeverity.border} ${currentSeverity.bg}`}
            >
              <span
                className={`h-2.5 w-2.5 shrink-0 rounded-full ${currentSeverity.dot}`}
              />
              <div className="min-w-0">
                <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500">
                  Fraud timeline signal
                </p>
                <p
                  className={`mt-1 truncate text-sm font-medium ${currentSeverity.text}`}
                >
                  {context.signal.label}
                </p>
              </div>
              <span className="ml-2 shrink-0 font-mono text-xs text-slate-400">
                {formatOffset(context.signal.recordingOffsetMs)}
              </span>
            </div>
          ) : null}

          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/88 via-black/50 to-transparent px-7 pb-6 pt-32">
            <div className="grid gap-4 lg:grid-cols-[1fr_0.82fr]">
              <div>
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                  <span className="text-sm font-medium">
                    Candidate live response
                  </span>
                </div>
                <p className="mt-2 line-clamp-2 text-sm leading-6 text-white/75">
                  {responseCaption ||
                    (context.verisState === "listening"
                      ? "Listening... candidate transcript is being captured."
                      : "Waiting for candidate response.")}
                </p>
              </div>
              <div className="rounded-xl border border-sky-300/15 bg-[#08111f]/80 px-4 py-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-sky-300/70">
                  VERIS asking
                </p>
                <p className="mt-2 line-clamp-2 text-sm font-medium leading-6 text-slate-100">
                  {context.questionText}
                </p>
              </div>
            </div>
          </div>
        </div>

        <aside className="grid min-h-0 grid-rows-[auto_minmax(0,0.95fr)_minmax(0,0.9fr)_minmax(0,0.75fr)] overflow-hidden rounded-[20px] border border-white/10 bg-[#0d1420]/95 p-6 shadow-2xl">
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
              Current VERIS question
            </p>
            <h1 className="mt-3 overflow-hidden text-[21px] font-medium leading-[1.35] text-slate-50 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:5]">
              {context.questionText}
            </h1>
            {latestQuestions.length > 1 ? (
              <div className="mt-4 space-y-2">
                {latestQuestions.slice(1, 3).map((item) => (
                  <p
                    key={item.id}
                    className="line-clamp-1 rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2 text-xs text-slate-400"
                  >
                    Q
                    {questionTrail.findIndex((entry) => entry.id === item.id) +
                      1}
                    : {item.text}
                  </p>
                ))}
              </div>
            ) : null}
          </div>

          <div className="min-h-0 overflow-hidden border-t border-white/10 pt-5">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">
                Candidate transcript
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
                  ? "Listening... the candidate's words will appear here."
                  : "Waiting for the candidate's response.")}
            </p>
            {transcriptHistory.length > 0 ? (
              <div className="mt-4 space-y-2">
                {transcriptHistory.slice(0, 2).map((item) => (
                  <p
                    key={`${item.questionId}-${item.at}`}
                    className="line-clamp-2 rounded-lg border border-emerald-300/10 bg-emerald-400/[0.04] px-3 py-2 text-xs leading-5 text-emerald-50/75"
                  >
                    {item.text}
                  </p>
                ))}
              </div>
            ) : null}
          </div>

          <div className="min-h-0 overflow-hidden border-t border-white/10 pt-5">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">
                Fraud detection timeline
              </p>
              <span className="font-mono text-[11px] text-slate-500">
                {latestSignals.length} live
              </span>
            </div>
            {latestSignals.length === 0 ? (
              <p className="mt-3 rounded-lg border border-white/5 bg-white/[0.03] px-3 py-3 text-sm text-slate-400">
                No suspicious behavior signals detected in the current window.
              </p>
            ) : (
              <div className="mt-3 space-y-2">
                {latestSignals.map((signal) => {
                  const style = severityClass(signal.severity);

                  return (
                    <div
                      key={signal.id}
                      className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 ${style.border} ${style.bg}`}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${style.dot}`}
                        />
                        <span
                          className={`truncate text-xs font-medium ${style.text}`}
                        >
                          {signal.label}
                        </span>
                      </div>
                      <span className="font-mono text-[11px] text-slate-400">
                        {formatOffset(signal.recordingOffsetMs)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </aside>
      </section>
    </main>
  );
}
