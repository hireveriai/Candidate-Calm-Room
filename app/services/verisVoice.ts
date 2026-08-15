import {
  boundBrowserTranscript,
  mergeMonotonicTranscript,
} from "@/app/lib/transcriptAccumulator";

export type VerisSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror?: ((event: { error?: string; message?: string }) => void) | null;
  start: () => void;
  stop: () => void;
  resetTranscript?: () => void;
  stopRequested?: boolean;
};

type SpeechRecognitionConstructor = new () => VerisSpeechRecognition;

type SpeechRecognitionAlternative = {
  transcript?: string;
};

type SpeechRecognitionResultLike = {
  isFinal: boolean;
  0?: SpeechRecognitionAlternative;
};

type SpeechRecognitionResultListLike = {
  length: number;
  [index: number]: SpeechRecognitionResultLike;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
};

type SpeechRecognitionWindow = Window &
  typeof globalThis & {
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
    SpeechRecognition?: SpeechRecognitionConstructor;
  };

let recognition: VerisSpeechRecognition | null = null;
let stopRequested = false;

type VerisAudioSink = (bytes: ArrayBuffer) => Promise<void>;

// Lets page.tsx inject a "play this into the recorded/published mix" callback
// (backed by VideoPanel's Web Audio mixer) without this module ever knowing
// about React or LiveKit.
let verisAudioSink: VerisAudioSink | null = null;
let activeAttemptId: string | null = null;
let fallbackAudioEl: HTMLAudioElement | null = null;

export function registerVerisAudioSink(sink: VerisAudioSink | null) {
  verisAudioSink = sink;
}

export function setVerisAttemptId(attemptId: string | null) {
  activeAttemptId = attemptId;
}

function normalizeChunk(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function mergeTranscriptParts(parts: string[]) {
  let merged = "";

  for (const part of parts.map(normalizeChunk).filter(Boolean)) {
    // Chrome can promote an interim phrase to a longer final phrase. Joining
    // both verbatim duplicates the entire phrase and can grow the transcript
    // fast enough to lock the browser's main thread.
    merged = mergeMonotonicTranscript(merged, part);
  }

  return merged;
}

async function fetchVerisSpeechBytes(
  text: string,
  signal: AbortSignal
): Promise<ArrayBuffer> {
  const response = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, attemptId: activeAttemptId }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`VERIS TTS request failed with status ${response.status}`);
  }

  return response.arrayBuffer();
}

function playViaFallbackAudioElement(bytes: ArrayBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    fallbackAudioEl ??= new Audio();
    const el = fallbackAudioEl;
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));

    const cleanup = () => {
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("error", onError);
      URL.revokeObjectURL(blobUrl);
    };
    const onEnded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("VERIS fallback audio element failed to play"));
    };

    el.addEventListener("ended", onEnded);
    el.addEventListener("error", onError);
    el.src = blobUrl;
    el.play().catch((error) => {
      cleanup();
      reject(error instanceof Error ? error : new Error("VERIS fallback audio play() rejected"));
    });
  });
}

const TTS_ATTEMPTS = 2;
const TTS_FETCH_TIMEOUT_MS = 10_000;

/**
 * Speaks `text` as VERIS in exactly one voice: the pinned cloud voice.
 *
 * Fetches "shimmer" from /api/tts and plays it through whichever sink is
 * registered (VideoPanel's recording mixer if available, otherwise a plain
 * <audio> element so the candidate still hears VERIS even before the mixer is
 * ready). A stalled or failed request is retried once, because that is
 * usually a cold start rather than a real outage.
 *
 * There used to be a window.speechSynthesis fallback here so the interview
 * could never go silent. It picked a voice by language alone, with no gender
 * preference, so it played whatever en-* voice the candidate's OS listed
 * first -- frequently a male voice on Windows. One stalled TTS request was
 * therefore enough to drop a second, different-sounding interviewer into the
 * middle of a session, and into the recording.
 *
 * So if the pinned voice still cannot be played, this resolves without
 * speaking rather than substituting another voice. Never reintroduce a
 * non-/api/tts speech path here: the question is already rendered on screen
 * (see QuestionRenderer), so silence costs the candidate far less than a
 * second interviewer voice costs the recording.
 */
export async function speak(text: string): Promise<void> {
  for (let attempt = 1; attempt <= TTS_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    // Guards only the network request, never playback. Playback is awaited to
    // natural completion below, and for a real question that legitimately runs
    // well past this timer.
    const fetchWatchdog = window.setTimeout(() => controller.abort(), TTS_FETCH_TIMEOUT_MS);

    try {
      const bytes = await fetchVerisSpeechBytes(text, controller.signal);
      window.clearTimeout(fetchWatchdog);

      if (verisAudioSink) {
        await verisAudioSink(bytes);
      } else {
        await playViaFallbackAudioElement(bytes);
      }

      return;
    } catch (error) {
      window.clearTimeout(fetchWatchdog);

      if (attempt < TTS_ATTEMPTS) {
        // A stalled request is usually a cold start or transient latency, not
        // a real outage. Retrying keeps the candidate on the pinned voice
        // instead of losing the audio for this question.
        console.warn(`VERIS TTS attempt ${attempt} failed; retrying.`, error);
        continue;
      }

      // Deliberately silent: speaking this question in some other voice is
      // worse than not speaking it. The question stays on screen.
      console.warn(
        "VERIS could not play this question in its own voice; continuing without audio for it.",
        error
      );
      return;
    }
  }
}

/**
 * Mobile browsers require audio output to be unlocked directly inside a user
 * gesture. This must run before fullscreen or network awaits. Unlocks every
 * playback primitive VERIS uses this session: the shared AudioContext (cloud
 * TTS + recording mix, if provided) and the fallback <audio> element (cloud
 * TTS when no mixer is registered yet).
 *
 * window.speechSynthesis is deliberately not unlocked here. VERIS no longer
 * speaks through it, and priming it used to emit a short utterance in the
 * device's own voice.
 */
export function primeVerisAudio(sharedContext?: AudioContext | null): boolean {
  let unlocked = false;

  if (sharedContext && sharedContext.state === "suspended") {
    void sharedContext.resume();
    unlocked = true;
  }

  try {
    fallbackAudioEl ??= new Audio();
    fallbackAudioEl.muted = true;
    void fallbackAudioEl.play()?.catch(() => {});
    fallbackAudioEl.muted = false;
    unlocked = true;
  } catch {
    // Best-effort only; playback errors are handled at speak()-time.
  }

  return unlocked;
}

export function startRecognition(
  onResult: (text: string) => void,
  onEnd?: () => void,
  onFinalResult?: (text: string) => void,
  initialTranscript = "",
  onError?: (error: string) => void
) {
  const SpeechRecognition =
    (window as SpeechRecognitionWindow).webkitSpeechRecognition ||
    (window as SpeechRecognitionWindow).SpeechRecognition;

  if (!SpeechRecognition) {
    console.warn("STT not supported");
    return null;
  }

  recognition = new SpeechRecognition();
  const activeRecognition = recognition;
  stopRequested = false;
  activeRecognition.stopRequested = false;
  let sessionBaseTranscript = normalizeChunk(initialTranscript);
  const recognizedResults = new Map<number, { text: string; final: boolean }>();
  let latestTranscript = boundBrowserTranscript(sessionBaseTranscript);

  activeRecognition.continuous = true;
  activeRecognition.interimResults = true;
  activeRecognition.lang = "en-US";
  activeRecognition.resetTranscript = () => {
    sessionBaseTranscript = "";
    recognizedResults.clear();
    latestTranscript = "";
  };

  activeRecognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const chunk = normalizeChunk(event.results[i][0]?.transcript || "");

      if (!chunk) {
        recognizedResults.delete(i);
        continue;
      }

      // A result index is revised in place by Chrome. Replacing that index
      // prevents progressive hypotheses ("prim", "primary", "primarily")
      // from being concatenated as separate sentences.
      recognizedResults.set(i, {
        text: chunk,
        final: event.results[i].isFinal,
      });
    }

    const orderedResults = [...recognizedResults.entries()].sort(
      ([left], [right]) => left - right
    );
    const finalizedText = boundBrowserTranscript(
      mergeMonotonicTranscript(
        sessionBaseTranscript,
        mergeTranscriptParts(
          orderedResults
            .filter(([, result]) => result.final)
            .map(([, result]) => result.text)
        )
      )
    );
    const observedText = boundBrowserTranscript(
      mergeMonotonicTranscript(
        sessionBaseTranscript,
        mergeTranscriptParts(
          orderedResults.map(([, result]) => result.text)
        )
      )
    );

    // `observedText` is an authoritative snapshot of this recognition
    // session. Keeping a previous, longer interim hypothesis makes Chrome's
    // in-place revisions look like additional speech at the page boundary.
    latestTranscript = observedText || finalizedText;
    onResult(latestTranscript);
    // Do not publish `finalizedText` as a second, shorter snapshot while an
    // interim tail exists. The interview page intentionally uses one handler
    // for both streams, so doing so truncates the answer just before save.
    onFinalResult?.(latestTranscript);
  };

  activeRecognition.onend = () => {
    if (activeRecognition.stopRequested) {
      return;
    }

    if (latestTranscript) {
      onResult(latestTranscript);
      onFinalResult?.(latestTranscript);
    }

    if (!stopRequested && onEnd) onEnd();
  };

  activeRecognition.onerror = (event) => {
    onError?.(event.error || event.message || "speech_recognition_error");
  };

  try {
    activeRecognition.start();
  } catch (error) {
    onError?.(
      error instanceof Error ? error.message : "speech_recognition_start_failed"
    );
    return null;
  }

  return activeRecognition;
}

export function stopRecognition(instance: VerisSpeechRecognition | null) {
  try {
    stopRequested = true;
    if (instance) {
      instance.stopRequested = true;
    }
    instance?.stop();
  } catch (e) {
    console.warn("Error stopping recognition", e);
  }
}
