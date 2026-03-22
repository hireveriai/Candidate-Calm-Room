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
      setDisplayText("");
      setIsVisible(false);
      return;
    }

    setDisplayText(text);
    setIsVisible(true);
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
