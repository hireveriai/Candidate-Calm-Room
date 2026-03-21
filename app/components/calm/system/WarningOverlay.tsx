"use client";

import { useEffect, useState } from "react";

type Props = {
  type: "soft" | "hard";
  message: string;
  visible: boolean;
};

export default function WarningOverlay({
  type,
  message,
  visible,
}: Props) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (visible) {
      setShow(true);

      const timer = setTimeout(() => {
        setShow(false);
      }, type === "hard" ? 3000 : 2000);

      return () => clearTimeout(timer);
    }
  }, [visible, type]);

  if (!show) return null;

  return (
    <div
      className={`absolute inset-0 flex items-center justify-center pointer-events-none z-50`}
    >
      <div
        className={`
          px-6 py-3 rounded-xl backdrop-blur-md
          text-white text-sm font-medium
          transition-all duration-300
          ${
            type === "hard"
              ? "bg-red-500/20 border border-red-400/40"
              : "bg-yellow-500/20 border border-yellow-400/40"
          }
        `}
      >
        {message}
      </div>
    </div>
  );
}