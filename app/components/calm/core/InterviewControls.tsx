"use client";

type Props = {
  onNext: () => void;
  onSkip: () => void;
  disabled?: boolean;
};

export default function InterviewControls({
  onNext,
  onSkip,
  disabled = false,
}: Props) {
  return (
    <div className="mt-6 flex items-center justify-center gap-4">
      <button
        onClick={onSkip}
        disabled={disabled}
        className="px-4 py-2 text-sm text-gray-400 border border-white/10 rounded-full hover:bg-white/5 transition disabled:cursor-not-allowed disabled:opacity-40"
      >
        Skip
      </button>

      <button
        onClick={onNext}
        disabled={disabled}
        className="px-5 py-2 text-sm bg-white/10 text-white rounded-full border border-white/20 hover:bg-white/20 transition disabled:cursor-not-allowed disabled:opacity-40"
      >
        Next Question
      </button>
    </div>
  );
}
