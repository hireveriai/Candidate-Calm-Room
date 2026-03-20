"use client"

export default function AnswerPanel() {

  return (

    <div className="w-full max-w-[320px] p-4">

      <div className="text-xs opacity-60 mb-3">
        Candidate Response
      </div>

      <div
        className="
        border border-white/10
        rounded-lg
        p-5
        bg-white/5
        min-h-[180px]
        flex items-center justify-center
        text-sm
        opacity-70
        text-center
        "
      >

        Waiting for response...

      </div>

      <div className="text-[11px] opacity-40 mt-3 text-center">
        Your spoken response will appear here.
      </div>

    </div>

  )
}