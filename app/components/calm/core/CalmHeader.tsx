"use client";

export default function CalmHeader() {
  return (
    <header className="relative z-10 flex h-[72px] w-full flex-none items-center border-b border-white/[0.07] bg-[#080c14]/80 px-5 backdrop-blur-xl sm:px-8">
      <div className="mx-auto flex w-full max-w-[1440px] items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-sky-300/20 bg-sky-300/[0.07] text-[11px] font-semibold tracking-[-0.05em] text-sky-100">
            HV
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
