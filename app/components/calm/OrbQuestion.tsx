"use client"

import { neuralSpine } from "@/app/lib/neuralSpine"
import { useEffect, useState, useRef } from "react"
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
  const orbRef = useRef<HTMLDivElement>(null)
  const hasSpoken = useRef(false)

  useEffect(() => {
  if (!audioReady) return

  if (!hasSpoken.current) {
    hasSpoken.current = true

    const t = setTimeout(() => {
      setShow(true)
      speak(QUESTIONS[index])
    }, 800)

    return () => clearTimeout(t)
  }
}, [audioReady, index])

if (!audioReady) {
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-lg">
      <button
        onClick={() => setAudioReady(true)}
        className="px-10 py-4 rounded-full border border-cyan-400/40
                   text-cyan-200 tracking-[0.3em] hover:bg-cyan-400/10 transition">
        BEGIN INTERVIEW
      </button>
    </div>
  )
}

  return (

    <div className="relative flex justify-center items-center mt-24">

      {/* Main Orb */}
      <div
        ref={orbRef}
        className={`
          relative w-64 h-64 rounded-full
          bg-cyan-400/10 backdrop-blur-xl
          border border-cyan-300/30
          shadow-[0_0_80px_rgba(0,255,255,0.15)]
          flex items-center justify-center
          transition-all duration-[1800ms]
          ${show ? "scale-100 opacity-100" : "scale-75 opacity-0"}
          animate-[float_8s_ease-in-out_infinite]
        `}
      >
        <div className="text-center text-sm px-6 opacity-80 leading-relaxed">
          {QUESTIONS[index]}
        </div>

        {/* Listening Satellite */}
        <div
          className="absolute left-1/2 -translate-x-1/2"
          style={{ bottom: "-90px" }}
        >
          <div
            style={{ transform: "scale(calc(1 + var(--mic-level) / 600))" }}
            className="w-36 h-36 rounded-full border border-cyan-400/20
                       transition-transform duration-75
                       flex items-center justify-center backdrop-blur-md"
          >
            <div className="text-[10px] tracking-[0.3em] opacity-40">
              LISTENING
            </div>
          </div>
        </div>
      </div>

      <div className="absolute top-full mt-28 text-xs opacity-40 text-center">
        Speak when ready. Veris is listening.
      </div>
    </div>
  )
}
