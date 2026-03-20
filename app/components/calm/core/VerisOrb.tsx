"use client";

import { motion } from "framer-motion";

type Props = {
  state: "idle" | "listening" | "thinking" | "speaking";
  audioLevel?: number; // 0 → 1
};

export default function VerisOrb({ state, audioLevel = 0 }: Props) {
  const isSpeaking = state === "speaking";
  const isListening = state === "listening";

  // 🎧 audio impact (stronger when speaking)
  const dynamicScale = 1 + audioLevel * (isSpeaking ? 0.6 : 0.3);

  return (
    <div className="flex items-center justify-center mt-6">

      <motion.div
        className="relative w-28 h-28 md:w-32 md:h-32 rounded-full flex items-center justify-center"
        animate={{
          scale: dynamicScale,
        }}
        transition={{
          duration: 0.2,
        }}
      >

        {/* OUTER FIELD */}
        <motion.div
          className="absolute inset-0 rounded-full border border-cyan-400/20"
          animate={{
            scale: [1, 1.25],
            opacity: [0.4, 0],
          }}
          transition={{
            duration: 2,
            repeat: Infinity,
          }}
        />

        {/* CORE */}
        <motion.div
          className="relative w-16 h-16 rounded-full"
          style={{
            background:
              "radial-gradient(circle at 30% 30%, rgba(34,211,238,0.9), rgba(139,92,246,0.6))",
            boxShadow:
              "0 0 30px rgba(34,211,238,0.5), inset 0 0 20px rgba(255,255,255,0.1)",
          }}
          animate={{
            scale: dynamicScale,
          }}
          transition={{
            duration: 0.2,
          }}
        />

      </motion.div>
    </div>
  );
}