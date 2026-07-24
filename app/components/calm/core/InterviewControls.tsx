"use client";

type Props = {
  onNext: () => void;
  onSkip: () => void;
  onExplainDifferently: () => void;
  disabled?: boolean;
  nextDisabled?: boolean;
  skipDisabled?: boolean;
  explainDisabled?: boolean;
  explainLabel?: string;
  primaryLabel?: string;
  message?: string;
};

export default function InterviewControls({
  onNext,
  onSkip,
  onExplainDifferently,
  disabled = false,
  nextDisabled = false,
  skipDisabled = false,
  explainDisabled = false,
  explainLabel = "Explain differently",
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
          onClick={onExplainDifferently}
          disabled={disabled || explainDisabled}
          className="rounded-lg border border-violet-200/15 bg-violet-200/[0.06] px-4 py-2.5 text-xs font-medium text-violet-100 transition hover:border-violet-200/25 hover:bg-violet-200/[0.1] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {explainLabel}
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
