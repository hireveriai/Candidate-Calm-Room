"use client";

import { useEffect, useState } from "react";

type Props = {
  text?: string;
};

function formatIntoTwoBalancedLines(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return "";
  }

  const words = normalized.split(" ");

  if (words.length <= 6) {
    return normalized;
  }

  const midpoint = Math.floor(normalized.length / 2);
  const spaces: number[] = [];

  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized[index] === " ") {
      spaces.push(index);
    }
  }

  if (!spaces.length) {
    return normalized;
  }

  let bestSplit = spaces[0];
  let bestDistance = Math.abs(bestSplit - midpoint);

  for (const spaceIndex of spaces) {
    const distance = Math.abs(spaceIndex - midpoint);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestSplit = spaceIndex;
    }
  }

  const firstLine = normalized.slice(0, bestSplit).trim();
  const secondLine = normalized.slice(bestSplit + 1).trim();

  if (!firstLine || !secondLine) {
    return normalized;
  }

  return `${firstLine}\n${secondLine}`;
}

export default function TranscriptStream({ text }: Props) {
  const [displayText, setDisplayText] = useState("");
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    if (!text) {
      setDisplayText("");
      setIsVisible(false);
      return;
    }

    setDisplayText(formatIntoTwoBalancedLines(text));
    setIsVisible(true);
  }, [text]);

  return (
    <div className="mt-5 min-h-[56px] w-full px-4 flex items-start justify-center sm:min-h-[64px]">
      <div
        className={`w-full text-center text-xs leading-5 text-gray-300 max-w-[21rem] px-2 tracking-wide whitespace-pre-line transition-opacity duration-700 sm:max-w-2xl sm:text-sm sm:leading-6 ${
          isVisible ? "opacity-100" : "opacity-0"
        }`}
        style={{ textWrap: "balance" }}
      >
        {displayText}
      </div>
    </div>
  );
}
