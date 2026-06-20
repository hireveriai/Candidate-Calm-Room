"use client";

type Props = {
  onNext: () => void;
  onSkip: () => void;
  disabled?: boolean;
  nextDisabled?: boolean;
  skipDisabled?: boolean;
  primaryLabel?: string;
  message?: string;
};

export default function InterviewControls({
  onNext,
  onSkip,
  disabled = false,
  nextDisabled = false,
  skipDisabled = false,
  primaryLabel = "Next Question",
  message,
}: Props) {
  return (
    <div className="mt-auto flex w-full flex-col gap-3 pt-6">
      {message ? (
        <div className="text-xs text-amber-200/80">{message}</div>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          onClick={onSkip}
          disabled={disabled || skipDisabled}
          className="rounded-lg border border-white/10 px-4 py-2.5 text-xs font-medium text-slate-400 transition hover:border-white/20 hover:bg-white/[0.04] hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Skip
        </button>

        <button
          onClick={onNext}
          disabled={disabled || nextDisabled}
          className="flex-1 rounded-lg border border-sky-200/20 bg-sky-200/[0.12] px-5 py-2.5 text-xs font-semibold text-sky-50 transition hover:border-sky-200/30 hover:bg-sky-200/[0.17] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {primaryLabel}
        </button>
      </div>
    </div>
  );
}
