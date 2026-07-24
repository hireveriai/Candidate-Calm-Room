import { mergeMonotonicTranscript } from "@/app/lib/transcriptAccumulator";

export type VerisSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
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

function normalizeChunk(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function mergeTranscriptParts(parts: string[]) {
  const merged: string[] = [];

  for (const part of parts.map(normalizeChunk).filter(Boolean)) {
    const last = merged[merged.length - 1];

    if (!last || (last !== part && !last.endsWith(part))) {
      merged.push(part);
    }
  }

  return merged.join(" ").trim();
}

export function speak(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) {
      console.warn("TTS not supported");
      resolve();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);

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
    utterance.onerror = finish;

    window.speechSynthesis.cancel(); // prevent overlap
    window.speechSynthesis.speak(utterance);
  });
}

export function startRecognition(
  onResult: (text: string) => void,
  onEnd?: () => void,
  onFinalResult?: (text: string) => void,
  initialTranscript = ""
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
  let finalizedChunks: string[] = [];
  let bestTranscript = sessionBaseTranscript;

  activeRecognition.continuous = true;
  activeRecognition.interimResults = true;
  activeRecognition.lang = "en-US";
  activeRecognition.resetTranscript = () => {
    sessionBaseTranscript = "";
    finalizedChunks = [];
    bestTranscript = "";
  };

  activeRecognition.onresult = (event) => {
    let interimChunks: string[] = [];

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const chunk = normalizeChunk(event.results[i][0]?.transcript || "");

      if (!chunk) {
        continue;
      }

      if (event.results[i].isFinal) {
        const lastChunk = finalizedChunks[finalizedChunks.length - 1];

        if (lastChunk !== chunk) {
          finalizedChunks = [...finalizedChunks, chunk];
        }
      } else {
        interimChunks = [...interimChunks, chunk];
      }
    }

    const finalizedText = mergeMonotonicTranscript(
      sessionBaseTranscript,
      mergeTranscriptParts(finalizedChunks)
    );
    const observedText = mergeMonotonicTranscript(
      sessionBaseTranscript,
      mergeTranscriptParts([...finalizedChunks, ...interimChunks])
    );

    if (observedText.length >= bestTranscript.length) {
      bestTranscript = observedText;
    }

    onResult(bestTranscript || observedText || finalizedText);
    onFinalResult?.(finalizedText || bestTranscript);
  };

  activeRecognition.onend = () => {
    if (activeRecognition.stopRequested) {
      return;
    }

    if (bestTranscript) {
      onResult(bestTranscript);
      onFinalResult?.(
        mergeMonotonicTranscript(
          sessionBaseTranscript,
          mergeTranscriptParts(finalizedChunks)
        ) || bestTranscript
      );
    }

    if (!stopRequested && onEnd) onEnd();
  };

  activeRecognition.start();

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
