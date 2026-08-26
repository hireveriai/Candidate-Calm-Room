"use client";

import { ArrowRight, MessageCircleQuestion, SkipForward } from "lucide-react";

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

      <div className="flex items-center justify-between gap-3">
        {/* Skip and "Explain differently" are both ways of not answering
            right now, so they're grouped as secondary actions on the left.
            Next Question is the one forward-moving primary action, kept
            visually separate on the right instead of stretched into the
            row so it reads as the CTA, not a third peer button. */}
        <div className="flex items-center gap-2.5">
          <button
            onClick={onSkip}
            disabled={disabled || skipDisabled}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-4 py-2.5 text-xs font-medium text-slate-400 transition hover:border-white/20 hover:bg-white/[0.04] hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <SkipForward className="h-3.5 w-3.5" />
            Skip
          </button>

          <button
            onClick={onExplainDifferently}
            disabled={disabled || explainDisabled}
            className="inline-flex items-center gap-1.5 rounded-lg border border-violet-200/15 bg-violet-200/[0.06] px-4 py-2.5 text-xs font-medium text-violet-100 transition hover:border-violet-200/25 hover:bg-violet-200/[0.1] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <MessageCircleQuestion className="h-3.5 w-3.5" />
            {explainLabel}
          </button>
        </div>

        <button
          onClick={onNext}
          disabled={disabled || nextDisabled}
          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-sky-200/20 bg-sky-200/[0.12] px-5 py-2.5 text-xs font-semibold text-sky-50 transition hover:border-sky-200/30 hover:bg-sky-200/[0.17] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {primaryLabel}
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
