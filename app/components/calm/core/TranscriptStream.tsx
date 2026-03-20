"use client";

import { useEffect, useState } from "react";

type Props = {
  text?: string;
};

export default function TranscriptStream({ text }: Props) {
  const [visibleWords, setVisibleWords] = useState<string[]>([]);
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    if (!text) return;

    const words = text.split(" ");
    let index = 0;

    setVisibleWords([]);
    setIsVisible(true);

    const interval = setInterval(() => {
      index++;
      setVisibleWords(words.slice(0, index));

      if (index >= words.length) {
        clearInterval(interval);

        setTimeout(() => {
          setIsVisible(false);
        }, 20000);
      }
    }, 200);

    return () => clearInterval(interval);
  }, [text]);

  return (
    <div className="mt-3 h-[40px] flex items-center justify-center">
      <div
        className={`text-sm text-gray-300 text-center max-w-md px-4 tracking-wide transition-opacity duration-700 ${
          isVisible ? "opacity-100" : "opacity-0"
        }`}
      >
        {visibleWords.join(" ")}
      </div>
    </div>
  );
}