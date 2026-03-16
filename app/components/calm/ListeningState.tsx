"use client"

import { useEffect, useState } from "react"

export default function ListeningState() {
  const [listening, setListening] = useState(false)

  useEffect(() => {
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(() => setListening(true))
      .catch(() => setListening(false))
  }, [])

  return (
<div className="absolute bottom-24 left-1/2 -translate-x-1/2 pointer-events-none">
      <div className={`w-36 h-36 rounded-full
        ${listening ? "border border-cyan-400/15 animate-pulse" : "border border-gray-600/10"}

        flex items-center justify-center
        backdrop-blur-md
      `}>
        <div className="text-[10px] tracking-[0.3em] opacity-40">
          {listening ? "LISTENING" : "MIC OFF"}
        </div>
      </div>
    </div>
  )
}
