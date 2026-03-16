"use client"

import { useEffect } from "react"

import CalmShell from "@/app/components/calm/CalmShell"
import VerisHeader from "@/app/components/calm/VerisHeader"
import BreathingHalo from "@/app/components/calm/BreathingHalo"
import OrbQuestion from "@/app/components/calm/OrbQuestion"
import ExitFade from "@/app/components/calm/ExitFade"
import AmbientMic from "@/app/components/calm/AmbientMic"

export default function CalmRoom({ params }: { params: { token: string } }) {

  const token = params.token
  const attemptId = token

  useEffect(() => {
    // Calm is thin
  }, [])

  return (
    <CalmShell>
      <VerisHeader />
      <BreathingHalo />
      <OrbQuestion />
      <AmbientMic active={true} attemptId={attemptId} />
      <ExitFade />
    </CalmShell>
  )
}