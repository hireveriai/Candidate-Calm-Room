"use client";

import { useEffect, useState } from "react";

type Props = {
  text?: string;
};

export default function TranscriptStream({ text }: Props) {
  const [displayText, setDisplayText] = useState("");
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    if (!text) {
      setIsVisible(false);
      return;
    }

    setIsVisible(false);

    const showTimeout = setTimeout(() => {
      setDisplayText(text);
      setIsVisible(true);
    }, 120);

    const hideTimeout = setTimeout(() => {
      setIsVisible(false);
    }, 20000);

    return () => {
      clearTimeout(showTimeout);
      clearTimeout(hideTimeout);
    };
  }, [text]);

  return (
    <div className="mt-3 h-[40px] flex items-center justify-center">
      <div
        className={`text-sm text-gray-300 text-center max-w-md px-4 tracking-wide transition-opacity duration-700 ${
          isVisible ? "opacity-100" : "opacity-0"
        }`}
      >
        {displayText}
      </div>
    </div>
  );
}
