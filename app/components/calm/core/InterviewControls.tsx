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
    <div className="mt-6 flex flex-col items-center justify-center gap-3">
      {message ? (
        <div className="text-xs tracking-wide text-cyan-200/80">{message}</div>
      ) : null}

      <div className="flex items-center justify-center gap-4">
        <button
          onClick={onSkip}
          disabled={disabled || skipDisabled}
          className="px-4 py-2 text-sm text-gray-400 border border-white/10 rounded-full hover:bg-white/5 transition disabled:cursor-not-allowed disabled:opacity-40"
        >
          Skip
        </button>

        <button
          onClick={onNext}
          disabled={disabled || nextDisabled}
          className="px-5 py-2 text-sm bg-white/10 text-white rounded-full border border-white/20 hover:bg-white/20 transition disabled:cursor-not-allowed disabled:opacity-40"
        >
          {primaryLabel}
        </button>
      </div>
    </div>
  );
}
