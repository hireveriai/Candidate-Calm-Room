export function speak(text: string) {
  if (!window.speechSynthesis) return

  const utter = new SpeechSynthesisUtterance(text)
  utter.rate = 0.92
  utter.pitch = 0.85
  utter.volume = 0.9
  utter.lang = "en-US"

  const voices = window.speechSynthesis.getVoices()

  const male = voices.find(v =>
    v.lang === "en-US" &&
    (
      v.name.toLowerCase().includes("male") ||
      v.name.toLowerCase().includes("david") ||   // Windows male
      v.name.toLowerCase().includes("mark") ||    // Mac male
      v.name.toLowerCase().includes("alex")       // Fallback
    )
  )

  if (male) utter.voice = male

  window.speechSynthesis.speak(utter)
}
