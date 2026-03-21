let recognition: any = null;

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

  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";

  recognition.onresult = (event: any) => {
    let transcript = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }

    onResult(transcript);
  };

  recognition.onend = () => {
    if (onEnd) onEnd();
  };

  recognition.start();

  return recognition;
}

export function stopRecognition(instance: any) {
  try {
    instance?.stop();
  } catch (e) {
    console.warn("Error stopping recognition", e);
  }
}