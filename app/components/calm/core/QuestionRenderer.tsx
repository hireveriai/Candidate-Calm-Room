"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * How the question text should follow VERIS's voice.
 *
 * - "full": show everything (default; also used whenever there is no audio,
 *   e.g. TTS failed, so the question is never hidden without being spoken).
 * - "pending": VERIS is about to speak; the audio has not started yet.
 * - "speaking": audio started at `startedAt` and runs for `durationMs`.
 *   `spokenPrefix` is any text VERIS says before the question itself (a
 *   clarification lead-in), which is spoken but not displayed.
 */
export type QuestionReveal =
  | { mode: "full" }
  | { mode: "pending" }
  | {
      mode: "speaking";
      startedAt: number;
      durationMs: number;
      spokenPrefix?: string;
    };

type Props = {
  question: string;
  questionType?: string | null;
  reveal?: QuestionReveal;
};

// Show each word a touch before it is heard; trailing the voice reads as lag.
const REVEAL_LEAD_MS = 120;

function splitWords(text: string) {
  return text.split(/\s+/).filter(Boolean);
}

// OpenAI TTS returns no word timings, so estimate them: a word takes time
// roughly in proportion to its length, and the voice pauses after punctuation.
function wordWeight(word: string) {
  const pause = /[.?!]["')\]]*$/.test(word)
    ? 6
    : /[,;:]["')\]]*$/.test(word)
      ? 3
      : 0;
  return word.length + 1 + pause;
}

/** Start time of each question word, as a fraction (0-1) of the full clip. */
function questionWordStartFractions(question: string, spokenPrefix = "") {
  const prefixWeight = splitWords(spokenPrefix).reduce(
    (sum, word) => sum + wordWeight(word),
    0
  );
  const words = splitWords(question);
  const total =
    prefixWeight + words.reduce((sum, word) => sum + wordWeight(word), 0);

  if (total <= 0) return [];

  let elapsed = prefixWeight;
  return words.map((word) => {
    const start = elapsed / total;
    elapsed += wordWeight(word);
    return start;
  });
}

export default function QuestionRenderer({
  question,
  reveal = { mode: "full" },
}: Props) {
  const words = useMemo(() => splitWords(question), [question]);

  const speakingTiming =
    reveal.mode === "speaking" && reveal.durationMs > 0 ? reveal : null;
  const startedAt = speakingTiming?.startedAt ?? 0;
  const durationMs = speakingTiming?.durationMs ?? 0;
  const spokenPrefix = speakingTiming?.spokenPrefix ?? "";

  const wordStartsMs = useMemo(
    () =>
      questionWordStartFractions(question, spokenPrefix).map(
        (fraction) => startedAt + fraction * durationMs - REVEAL_LEAD_MS
      ),
    [question, spokenPrefix, startedAt, durationMs]
  );

  // Tagged with the timing it was computed for, so a new question never
  // briefly inherits the previous question's fully revealed count.
  const [revealed, setRevealed] = useState<{
    timing: number[];
    count: number;
  } | null>(null);
  const revealedCount = revealed?.timing === wordStartsMs ? revealed.count : 0;

  useEffect(() => {
    if (durationMs <= 0) return;

    let frame = 0;
    const tick = () => {
      const now = performance.now();
      let count = 0;
      while (count < wordStartsMs.length && wordStartsMs[count] <= now) {
        count += 1;
      }
      setRevealed({ timing: wordStartsMs, count });
      if (count < wordStartsMs.length) {
        frame = requestAnimationFrame(tick);
      }
    };
    frame = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frame);
  }, [wordStartsMs, durationMs]);

  // A speaking reveal with an unknown duration can't be timed, so it falls
  // back to showing the whole question rather than hiding it.
  const visibleCount =
    reveal.mode === "pending"
      ? 0
      : speakingTiming
        ? revealedCount
        : words.length;

  return (
    <section className="w-full">
      <p className="mb-3 text-[10px] font-medium uppercase tracking-[0.2em] text-sky-300/70">
        Interview question
      </p>
      {/* Every word is always laid out; unspoken ones are just transparent,
          so the text never reflows or jumps as it fills in. */}
      <p
        aria-label={visibleCount >= words.length ? question : undefined}
        className="text-[17px] font-medium leading-7 tracking-[-0.01em] text-slate-50 sm:text-[19px] sm:leading-8"
      >
        {words.map((word, index) => (
          <span
            key={`${index}-${word}`}
            aria-hidden={index >= visibleCount || undefined}
            className={`transition-opacity duration-200 ${
              index < visibleCount ? "opacity-100" : "opacity-0"
            }`}
          >
            {word}
            {index < words.length - 1 ? " " : ""}
          </span>
        ))}
      </p>
    </section>
  );
}
