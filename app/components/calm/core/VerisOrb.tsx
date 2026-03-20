"use client";

import { motion } from "framer-motion";

type Props = {
  state: "idle" | "listening" | "thinking" | "speaking";
};

export default function VerisOrb({ state }: Props) {
  return (
    <div className="flex flex-col items-center justify-center mt-6 gap-3">
      
      {/* ORB */}
      <motion.div
        className="relative w-20 h-20 md:w-24 md:h-24 rounded-full border border-cyan-400/30 bg-gradient-to-br from-cyan-500/20 to-purple-500/20"
        animate={{
          scale:
            state === "speaking"
              ? [1, 1.1, 1]
              : state === "listening"
              ? [1, 1.05, 1]
              : 1,
        }}
        transition={{
          duration: 1.5,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      >
        {/* INNER CORE (alive effect) */}
        <div className="absolute inset-0 flex items-center justify-center">
          <motion.div
            className="w-3 h-3 rounded-full bg-cyan-400 blur-sm"
            animate={{
              scale: state === "speaking" ? [1, 1.6, 1] : [1, 1.2, 1],
              opacity: [0.5, 1, 0.5],
            }}
            transition={{
              duration: 1.2,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          />
        </div>

        {/* OUTER GLOW */}
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
      </motion.div>

    </div>
  );
}