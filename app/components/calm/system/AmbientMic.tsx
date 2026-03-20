"use client"

import { useEffect } from "react"

export default function AmbientMic({
  active,
  attemptId
}: {
  active: boolean
  attemptId: string
}) {
  useEffect(() => {
    if (!active || !attemptId) return

    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      const ctx = new AudioContext()
      ctx.resume()

      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512

      const mic = ctx.createMediaStreamSource(stream)
      mic.connect(analyser)

      const data = new Uint8Array(analyser.frequencyBinCount)

      const emit = async (stream: string, value: number) => {
        try {
          await fetch("http://localhost:4001/mri/ingest", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              attempt_id: attemptId,
              stream,
              value,
              source: "calm-ui"
            })
          })
        } catch (e) {
          // MRI server offline = Calm UI must NEVER crash
          console.warn("MRI offline")
        }
      }

      const loop = () => {
        analyser.getByteFrequencyData(data)
        const volume = data.reduce((a, b) => a + b) / data.length

        emit("stress", Math.min(100, volume))
        emit("confidence", Math.max(0, 100 - volume))
        emit("thinking", volume > 45 ? 1 : 0)

        requestAnimationFrame(loop)
      }

      loop()
    })
  }, [active, attemptId])

  return null
}
