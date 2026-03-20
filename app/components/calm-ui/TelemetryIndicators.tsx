"use client";

export default function TelemetryIndicators() {
  return (
    <div className="flex gap-6 text-xs relative z-20">

      <Indicator label="Face detected" status="green" />
      <Indicator label="Microphone active" status="green" />
      <Indicator label="Attention tracking" status="orange" />
      <Indicator label="Secure mode" status="green" />

    </div>
  );
}

function Indicator({
  label,
  status,
}: {
  label: string;
  status: "green" | "red" | "orange";
}) {
  const color =
  status === "green"
    ? "bg-green-400"
    : status === "red"
    ? "bg-red-400"
    : "bg-yellow-400";

  return (
    <div className="flex items-center gap-2 text-white/70">

      <span className={`w-2 h-2 rounded-full ${color}`} />

      <span>{label}</span>

    </div>
  );
}