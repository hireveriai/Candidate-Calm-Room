"use client"

import { useEffect, useState } from "react"
import { speak } from "@/app/services/verisVoice"

const QUESTIONS = [
  "Tell me about a technical problem you recently solved.",
  "What part of your work challenges you the most?",
  "Explain a system you built that you are proud of."
]

export default function OrbQuestion() {
  const [audioReady, setAudioReady] = useState(false)
  const [index] = useState(0)
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (!audioReady) return

    setShow(true)

    try {
      speak(QUESTIONS[index])
    } catch (e) {
      console.log("voice error", e)
    }
  }, [audioReady, index])

  // 🔒 ENTRY SCREEN
  if (!audioReady) {
    return (
      <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black">
        <button
          onClick={() => setAudioReady(true)}
          className="
          px-10 py-4 rounded-full
          border border-cyan-400/40
          text-cyan-200 tracking-[0.3em]
          hover:bg-cyan-400/10 transition
          "
        >
          BEGIN INTERVIEW
        </button>
      </div>
    )
  }

  return (
    <div className="relative flex flex-col items-center justify-center mt-16">

      {/* 🔮 ORB */}
      <div className="relative flex items-center justify-center">

        {/* Outer Glow */}
        <div className="absolute w-72 h-72 rounded-full bg-cyan-400/10 blur-2xl" />

        {/* Glass Orb */}
        <div
          className={`
          relative w-56 h-56 rounded-full
          bg-[radial-gradient(circle_at_30%_30%,rgba(59,130,246,0.25),#020617)]
          border border-cyan-300/20
          shadow-[0_0_60px_rgba(0,255,255,0.15)]
          overflow-hidden
          transition-all duration-700
          ${show ? "scale-100 opacity-100" : "scale-90 opacity-0"}
          `}
        >

          {/* Inner Glow */}
          <div className="absolute inset-0 bg-cyan-400/10 blur-xl" />

          {/* Wave Animation */}
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="wave" />
          </div>

        </div>
      </div>

      {/* 📝 QUESTION OUTSIDE ORB */}
      <div
        className={`
        mt-10 max-w-xl text-center px-6
        transition-all duration-700
        ${show ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"}
        `}
      >
        <div className="text-lg text-white/90 leading-relaxed">
          {QUESTIONS[index]}
        </div>
      </div>

      {/* 👉 RIGHT SIDE GUIDANCE */}
      <div
        className="
        absolute right-10 top-1/2 -translate-y-1/2
        text-right space-y-2
        hidden md:block
        "
      >
        <div className="text-sm text-cyan-300/80">
          Veris is listening
        </div>

        <div className="text-xs text-white/40">
          Speak when ready
        </div>
      </div>



    </div>
  )
}