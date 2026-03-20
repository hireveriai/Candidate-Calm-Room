let isSpeaking = false;

// 🔊 TEXT TO SPEECH
export function speak(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (isSpeaking) {
      window.speechSynthesis.cancel();
    }

    const utterance = new SpeechSynthesisUtterance(text);

    utterance.rate = 0.95;
    utterance.pitch = 1;

    utterance.onstart = () => {
      isSpeaking = true;
    };

    utterance.onend = () => {
      isSpeaking = false;
      resolve();
    };

    utterance.onerror = () => {
      isSpeaking = false;
      resolve();
    };

    window.speechSynthesis.speak(utterance);
  });
}

// 🎤 SPEECH TO TEXT (LIVE)
export function startRecognition(
  onResult: (text: string) => void,
  onEnd: () => void
) {
  const SpeechRecognition =
    (window as any).SpeechRecognition ||
    (window as any).webkitSpeechRecognition;

  if (!SpeechRecognition) {
    alert("Speech recognition not supported in this browser");
    return null;
  }

  const recognition = new SpeechRecognition();

  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";

  recognition.onresult = (event: any) => {
    let transcript = "";

    for (let i = 0; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }

    onResult(transcript);
  };

  recognition.onend = () => {
    onEnd();
  };

  recognition.start();

  return recognition;
}

// 🛑 STOP MIC
export function stopRecognition(recognition: any) {
  if (recognition) {
    recognition.stop();
  }
}