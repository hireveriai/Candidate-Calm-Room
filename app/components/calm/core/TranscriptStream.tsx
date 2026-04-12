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
    <div className="mt-5 min-h-[56px] px-4 flex items-start justify-center sm:min-h-[64px]">
      <div
        className={`text-sm leading-5 text-gray-300 text-center max-w-[18rem] px-2 tracking-wide transition-opacity duration-700 sm:max-w-md sm:text-[15px] sm:leading-6 ${
          isVisible ? "opacity-100" : "opacity-0"
        }`}
        style={{
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          textWrap: "balance",
        }}
      >
        {displayText}
      </div>
    </div>
  );
}
