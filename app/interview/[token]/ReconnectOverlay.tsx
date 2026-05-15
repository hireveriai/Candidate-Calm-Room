"use client";

type Props = {
  visible: boolean;
  attempt: number;
  maxAttempts: number;
  countdownSeconds: number;
  networkOnline: boolean;
  cameraReady: boolean;
  microphoneReady: boolean;
  reason: string;
  mediaRecoveryError?: string | null;
  onRetry?: () => void;
};

function statusTone(healthy: boolean) {
  return healthy
    ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-200"
    : "border-amber-400/20 bg-amber-400/10 text-amber-100";
}

export default function ReconnectOverlay({
  visible,
  attempt,
  maxAttempts,
  countdownSeconds,
  networkOnline,
  cameraReady,
  microphoneReady,
  reason,
  mediaRecoveryError,
  onRetry,
}: Props) {
  if (!visible) {
    return null;
  }

  return (
    <div className="absolute inset-0 z-[80] flex items-center justify-center bg-[#07101C]/94 backdrop-blur-xl">
      <div className="mx-6 w-full max-w-2xl rounded-[32px] border border-cyan-400/10 bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.12),transparent_38%),rgba(9,15,28,0.96)] p-8 shadow-[0_30px_120px_rgba(2,8,23,0.68)]">
        <div className="mb-5 flex items-center gap-3">
          <span className="flex h-3 w-3 rounded-full bg-cyan-300 shadow-[0_0_18px_rgba(103,232,249,0.9)]" />
          <p className="text-[11px] uppercase tracking-[0.32em] text-cyan-200/80">
            Session Recovery
          </p>
        </div>

        <h2 className="text-3xl font-medium tracking-[-0.03em] text-white">
          Secure connection interrupted
        </h2>
        <p className="mt-3 max-w-xl text-sm leading-7 text-slate-300">
          Restoring interview session so you can continue from the same point.
        </p>

        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          <div className={`rounded-2xl border px-4 py-3 ${statusTone(networkOnline)}`}>
            <div className="text-[10px] uppercase tracking-[0.24em] text-inherit/80">
              Network
            </div>
            <div className="mt-1 text-sm font-medium">
              {networkOnline ? "Connected" : "Offline"}
            </div>
          </div>

          <div className={`rounded-2xl border px-4 py-3 ${statusTone(cameraReady)}`}>
            <div className="text-[10px] uppercase tracking-[0.24em] text-inherit/80">
              Camera
            </div>
            <div className="mt-1 text-sm font-medium">
              {cameraReady ? "Ready" : "Recovering"}
            </div>
          </div>

          <div
            className={`rounded-2xl border px-4 py-3 ${statusTone(microphoneReady)}`}
          >
            <div className="text-[10px] uppercase tracking-[0.24em] text-inherit/80">
              Microphone
            </div>
            <div className="mt-1 text-sm font-medium">
              {microphoneReady ? "Ready" : "Recovering"}
            </div>
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-4">
          <div className="flex items-center justify-between gap-4 text-sm text-slate-200">
            <span>Reconnecting {attempt}/{maxAttempts}</span>
            <span>Retrying in {countdownSeconds}s</span>
          </div>

          <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/8">
            <div
              className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-sky-400 to-blue-500 transition-all duration-700"
              style={{
                width: `${Math.min((attempt / maxAttempts) * 100, 100)}%`,
              }}
            />
          </div>
        </div>

        <div className="mt-4 rounded-2xl border border-white/8 bg-black/20 px-5 py-4 text-sm text-slate-300">
          {mediaRecoveryError
            ? mediaRecoveryError
            : reason || "Re-establishing network, media, and session heartbeat."}
        </div>

        {mediaRecoveryError && onRetry ? (
          <div className="mt-5 flex justify-end">
            <button
              type="button"
              onClick={onRetry}
              className="rounded-full border border-cyan-300/25 bg-cyan-400/10 px-5 py-2 text-sm text-cyan-100 transition hover:bg-cyan-400/16"
            >
              Retry recovery
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
