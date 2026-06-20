"use client";

type VerisState = "idle" | "listening" | "thinking" | "speaking";

type Props = {
  faceCount: number;
  micActive: boolean;
  attention: boolean;
  secure: boolean;
  verisState: VerisState;
};

export default function SystemIndicators({
  faceCount,
  micActive,
  attention,
  secure,
  verisState,
}: Props) {
  const faceStatus =
    faceCount === 1
      ? { label: "Face visible", tone: "bg-emerald-400" }
      : faceCount === 0
        ? { label: "Face not visible", tone: "bg-amber-400" }
        : { label: "Multiple faces", tone: "bg-red-400" };

  const indicators = [
    faceStatus,
    {
      label: micActive ? "Microphone active" : "Microphone ready",
      tone: micActive ? "bg-emerald-400" : "bg-slate-500",
    },
    {
      label: attention ? "Attention confirmed" : "Return focus",
      tone: attention ? "bg-emerald-400" : "bg-amber-400",
    },
    {
      label: secure ? "Connection secured" : "Security check",
      tone: secure ? "bg-emerald-400" : "bg-amber-400",
    },
  ];

  return (
    <section className="mt-3 rounded-xl border border-white/[0.07] bg-white/[0.025] px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {indicators.map((indicator) => (
          <div key={indicator.label} className="flex items-center gap-2">
            <span className={`h-1.5 w-1.5 rounded-full ${indicator.tone}`} />
            <span className="text-[11px] text-slate-400">{indicator.label}</span>
          </div>
        ))}
        <div className="ml-auto hidden text-[11px] text-slate-500 md:block">
          {verisState === "speaking"
            ? "Question in progress"
            : verisState === "listening"
              ? "Response being captured"
              : "Preparing next step"}
        </div>
      </div>
    </section>
  );
}
