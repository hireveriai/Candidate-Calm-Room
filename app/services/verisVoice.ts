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
let speechSynthesisPrimed = false;

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

/**
 * Last-resort path if OpenAI TTS is unreachable for this utterance: the
 * original browser-local speech synthesis behavior, kept intact so the
 * interview never goes silent just because the cloud voice is unavailable.
 */
function speakWithBrowserSynthesis(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) {
      console.warn("TTS not supported");
      resolve();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    const preferredVoice =
      voices.find((voice) => /^en-IN$/i.test(voice.lang)) ??
      voices.find((voice) => /^en-(US|GB)$/i.test(voice.lang)) ??
      voices.find((voice) => /^en\b/i.test(voice.lang));
    if (preferredVoice) {
      utterance.voice = preferredVoice;
      utterance.lang = preferredVoice.lang;
    } else {
      utterance.lang = "en-US";
    }

    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.volume = 1;

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(watchdog);
      resolve();
    };
    const estimatedSpeechMs = Math.max(8_000, text.trim().split(/\s+/).length * 650);
    const watchdog = window.setTimeout(() => {
      console.warn("Speech synthesis stalled; continuing the interview.");
      window.speechSynthesis.cancel();
      finish();
    }, Math.min(30_000, estimatedSpeechMs));

    utterance.onend = finish;
    utterance.onerror = (event) => {
      console.warn("Speech synthesis could not play the VERIS question.", {
        error: event.error,
        primed: speechSynthesisPrimed,
        userAgent: navigator.userAgent,
      });
      finish();
    };

    window.speechSynthesis.cancel(); // prevent overlap
    window.speechSynthesis.resume();
    window.speechSynthesis.speak(utterance);
  });
}

/**
 * Speaks `text` as VERIS using the pinned cloud voice. Signature is
 * intentionally identical to the old browser-only implementation so callers
 * never need to change.
 *
 * Order of preference: fetch the pinned "shimmer" voice from /api/tts, then
 * play it through whichever sink is registered (VideoPanel's recording
 * mixer if available, otherwise a plain <audio> element so the candidate
 * still hears VERIS even before the mixer is ready). If the fetch or
 * playback fails outright, fall back to the original browser
 * speechSynthesis behavior so the interview can never go silent.
 */
export function speak(text: string): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let fallbackStarted = false;
    const controller = new AbortController();

    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(watchdog);
      resolve();
    };

    const runFallback = () => {
      if (fallbackStarted) return;
      fallbackStarted = true;
      controller.abort();
      void speakWithBrowserSynthesis(text).finally(finish);
    };

    const estimatedSpeechMs = Math.max(8_000, text.trim().split(/\s+/).length * 650);
    // Shorter than the browser-synthesis watchdog above: this one only needs
    // to cover the network round trip before handing off to that fallback,
    // which has its own watchdog for the actual spoken duration.
    const watchdog = window.setTimeout(() => {
      console.warn("VERIS TTS stalled; falling back to browser speech synthesis.");
      runFallback();
    }, Math.min(12_000, estimatedSpeechMs));

    fetchVerisSpeechBytes(text, controller.signal)
      .then(async (bytes) => {
        if (settled || fallbackStarted) return;

        try {
          if (verisAudioSink) {
            await verisAudioSink(bytes);
          } else {
            await playViaFallbackAudioElement(bytes);
          }
          finish();
        } catch (playbackError) {
          if (settled || fallbackStarted) return;
          console.warn(
            "VERIS audio playback failed; falling back to browser speech synthesis.",
            playbackError
          );
          runFallback();
        }
      })
      .catch((error) => {
        if (settled || fallbackStarted) return;
        if (error instanceof DOMException && error.name === "AbortError") {
          // The watchdog already started the fallback for this call.
          return;
        }
        console.warn(
          "VERIS TTS request failed; falling back to browser speech synthesis.",
          error
        );
        runFallback();
      });
  });
}

/**
 * Mobile browsers require audio output to be unlocked directly inside a user
 * gesture. This must run before fullscreen or network awaits. Unlocks every
 * playback primitive VERIS might use this session: the shared AudioContext
 * (cloud TTS + recording mix, if provided), the fallback <audio> element
 * (cloud TTS when no mixer is registered yet), and window.speechSynthesis
 * (last-resort fallback if OpenAI TTS is unavailable for the whole
 * interview).
 */
export function primeVerisAudio(sharedContext?: AudioContext | null): boolean {
  let unlocked = false;

  if (sharedContext && sharedContext.state === "suspended") {
    void sharedContext.resume();
    unlocked = true;
  }

  if (
    typeof window !== "undefined" &&
    window.speechSynthesis &&
    typeof SpeechSynthesisUtterance !== "undefined"
  ) {
    try {
      window.speechSynthesis.cancel();
      window.speechSynthesis.resume();
      const unlock = new SpeechSynthesisUtterance(".");
      unlock.volume = 0.01;
      unlock.rate = 10;
      window.speechSynthesis.speak(unlock);
      speechSynthesisPrimed = true;
      unlocked = true;
    } catch (error) {
      console.warn("Unable to unlock VERIS speech synthesis fallback.", error);
    }
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
