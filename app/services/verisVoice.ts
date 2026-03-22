let recognition: any = null;
let stopRequested = false;

function normalizeChunk(text: string) {
  return text.replace(/\s+/g, " ").trim();
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
  onEnd?: () => void
) {
  const SpeechRecognition =
    (window as any).webkitSpeechRecognition ||
    (window as any).SpeechRecognition;

  if (!SpeechRecognition) {
    console.warn("STT not supported");
    return null;
  }

  recognition = new SpeechRecognition();
  stopRequested = false;
  let finalizedChunks: string[] = [];

  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";

  recognition.onresult = (event: any) => {
    let interimChunks: string[] = [];

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const chunk = normalizeChunk(event.results[i][0].transcript || "");

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

    onResult([...finalizedChunks, ...interimChunks].join(" ").trim());
  };

  recognition.onend = () => {
    if (!stopRequested && onEnd) onEnd();
  };

  recognition.start();

  return recognition;
}

export function stopRecognition(instance: any) {
  try {
    stopRequested = true;
    instance?.stop();
  } catch (e) {
    console.warn("Error stopping recognition", e);
  }
}
