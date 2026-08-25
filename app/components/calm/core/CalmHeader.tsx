"use client";

export default function CalmHeader() {
  return (
    <header className="relative z-10 flex h-[72px] w-full flex-none items-center border-b border-white/[0.07] bg-[#080c14]/80 px-5 backdrop-blur-xl sm:px-8">
      <div className="mx-auto flex w-full max-w-[1440px] items-center justify-between">
        <div className="flex items-center gap-4">
          {/* Monogram, not a flat tinted square: a soft gradient face, an
              inset top highlight to give it an edge, and a low cyan glow so
              it reads as a lit object on the near-black header rather than a
              placeholder box. Negative tracking cramped two capitals, so the
              letters sit at their natural width. */}
          <div className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-[linear-gradient(145deg,rgba(56,189,248,0.20),rgba(14,116,144,0.08))] shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_1px_2px_rgba(0,0,0,0.45),0_0_20px_-6px_rgba(56,189,248,0.55)] ring-1 ring-inset ring-sky-300/25">
            <span className="bg-[linear-gradient(180deg,#f0f9ff,#7dd3fc)] bg-clip-text text-[12px] font-semibold leading-none tracking-[0.01em] text-transparent">
              VN
            </span>
          </div>
          <div>
            <h1 className="text-[13px] font-semibold tracking-[0.24em] text-white/90">
              VERIS
            </h1>
            <p className="mt-0.5 text-[11px] text-slate-500">
              Secure interview environment
            </p>
          </div>
        </div>

        <div className="mr-16 hidden items-center gap-2 text-[11px] text-slate-400 sm:flex">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          Session in progress
        </div>
      </div>
    </header>
  );
}
