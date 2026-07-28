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

export function speak(text: string): Promise<void> {
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
 * Mobile browsers require audio output to be unlocked directly inside a user
 * gesture. This must run before fullscreen or network awaits.
 */
export function primeSpeechSynthesis() {
  if (
    typeof window === "undefined" ||
    !window.speechSynthesis ||
    typeof SpeechSynthesisUtterance === "undefined"
  ) {
    return false;
  }

  try {
    window.speechSynthesis.cancel();
    window.speechSynthesis.resume();
    const unlock = new SpeechSynthesisUtterance(".");
    unlock.volume = 0.01;
    unlock.rate = 10;
    window.speechSynthesis.speak(unlock);
    speechSynthesisPrimed = true;
    return true;
  } catch (error) {
    console.warn("Unable to unlock VERIS speech synthesis.", error);
    return false;
  }
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
