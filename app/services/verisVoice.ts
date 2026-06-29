export type VerisSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
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

    utterance.onend = () => resolve();

    window.speechSynthesis.cancel(); // prevent overlap
    window.speechSynthesis.speak(utterance);
  });
}

export function startRecognition(
  onResult: (text: string) => void,
  onEnd?: () => void,
  onFinalResult?: (text: string) => void
) {
  const SpeechRecognition =
    (window as SpeechRecognitionWindow).webkitSpeechRecognition ||
    (window as SpeechRecognitionWindow).SpeechRecognition;

  if (!SpeechRecognition) {
    console.warn("STT not supported");
    return null;
  }

  recognition = new SpeechRecognition();
  stopRequested = false;
  let finalizedChunks: string[] = [];
  let bestTranscript = "";

  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";

  recognition.onresult = (event) => {
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

    const finalizedText = mergeTranscriptParts(finalizedChunks);
    const observedText = mergeTranscriptParts([...finalizedChunks, ...interimChunks]);

    if (observedText.length >= bestTranscript.length) {
      bestTranscript = observedText;
    }

    onResult(bestTranscript || observedText || finalizedText);
    onFinalResult?.(finalizedText || bestTranscript);
  };

  recognition.onend = () => {
    if (bestTranscript) {
      onResult(bestTranscript);
      onFinalResult?.(mergeTranscriptParts(finalizedChunks) || bestTranscript);
    }

    if (!stopRequested && onEnd) onEnd();
  };

  recognition.start();

  return recognition;
}

export function stopRecognition(instance: VerisSpeechRecognition | null) {
  try {
    stopRequested = true;
    instance?.stop();
  } catch (e) {
    console.warn("Error stopping recognition", e);
  }
}
