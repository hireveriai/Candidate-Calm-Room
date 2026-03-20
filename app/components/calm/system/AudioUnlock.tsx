"use client"
import { useState } from "react"

export default function AudioUnlock({ onUnlock }: { onUnlock: () => void }) {
  const [unlocked, setUnlocked] = useState(false)

  if (unlocked) return null

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur">
      <button
        onClick={() => { setUnlocked(true); onUnlock() }}
        className="px-6 py-3 rounded-full border border-cyan-400/40
                   text-cyan-200 tracking-widest hover:bg-cyan-400/10 transition">
        Begin Interview
      </button>
    </div>
  )
}
