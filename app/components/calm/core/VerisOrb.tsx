"use client";

import { motion } from "framer-motion";

type Props = {
  state: "idle" | "listening" | "thinking" | "speaking";
  audioLevel?: number;
};

const WAVE_POINTS = Array.from({ length: 56 }, (_, index) => {
  const progress = index / 55;
  const x = progress * 100;
  const baseY = 50 + Math.sin(progress * Math.PI * 4) * 10;
  const altY = 50 + Math.sin(progress * Math.PI * 4 + 0.9) * 7;

  return {
    id: index,
    x,
    baseY,
    altY,
    size: index % 6 === 0 ? 2.8 : index % 3 === 0 ? 2.2 : 1.6,
    delay: progress * 0.9,
  };
});

export default function VerisOrb({ state, audioLevel = 0 }: Props) {
  const isSpeaking = state === "speaking";
  const isListening = state === "listening";
  const isThinking = state === "thinking";

  const sphereScale = 1 + audioLevel * (isSpeaking ? 0.12 : 0.06);
  const glowOpacity = isSpeaking ? 0.95 : isListening ? 0.82 : isThinking ? 0.72 : 0.58;
  const waveTravel = isSpeaking ? 16 : isListening ? 10 : isThinking ? 7 : 5;
  const waveDuration = isSpeaking ? 1.4 : isListening ? 2 : 2.4;

  return (
    <div className="mt-3 flex items-center justify-center">
      <motion.div
        className="relative flex h-36 w-36 items-center justify-center md:h-40 md:w-40"
        animate={{ scale: sphereScale }}
        transition={{ duration: 0.24, ease: "easeOut" }}
      >
        <motion.div
          className="absolute inset-[-18%] rounded-full"
          style={{
            background:
              "radial-gradient(circle, rgba(34,211,238,0.16) 0%, rgba(56,189,248,0.06) 38%, rgba(2,6,23,0) 74%)",
            filter: "blur(18px)",
          }}
          animate={{
            opacity: [0.3, glowOpacity, 0.3],
            scale: [0.95, 1.08, 0.95],
          }}
          transition={{
            duration: 3.2,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />

        <motion.div
          className="absolute inset-0 rounded-full"
          style={{
            background:
              "radial-gradient(circle at 50% 28%, rgba(255,255,255,0.08) 0%, rgba(125,211,252,0.05) 18%, rgba(14,20,46,0.74) 58%, rgba(4,8,24,0.97) 100%)",
            border: "1.5px solid rgba(34, 211, 238, 0.88)",
            boxShadow:
              "0 0 26px rgba(34,211,238,0.38), inset 0 0 28px rgba(34,211,238,0.08), inset 0 -18px 32px rgba(0,0,0,0.34)",
          }}
          animate={{
            boxShadow: [
              "0 0 22px rgba(34,211,238,0.3), inset 0 0 28px rgba(34,211,238,0.08), inset 0 -18px 32px rgba(0,0,0,0.34)",
              "0 0 34px rgba(34,211,238,0.46), inset 0 0 34px rgba(34,211,238,0.12), inset 0 -18px 32px rgba(0,0,0,0.34)",
              "0 0 22px rgba(34,211,238,0.3), inset 0 0 28px rgba(34,211,238,0.08), inset 0 -18px 32px rgba(0,0,0,0.34)",
            ],
          }}
          transition={{
            duration: 2.8,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />

        <div className="absolute inset-[3.5%] overflow-hidden rounded-full">
          <div
            className="absolute inset-0 rounded-full"
            style={{
              background:
                "radial-gradient(circle at 50% 16%, rgba(255,255,255,0.1), rgba(255,255,255,0.025) 18%, rgba(255,255,255,0) 38%)",
            }}
          />

          <motion.div
            className="absolute inset-x-[16%] top-[14%] h-[1px]"
            style={{
              background:
                "linear-gradient(90deg, rgba(34,211,238,0) 0%, rgba(191,219,254,0.5) 50%, rgba(34,211,238,0) 100%)",
              boxShadow: "0 0 8px rgba(125,211,252,0.35)",
            }}
            animate={{
              opacity: [0.18, 0.46, 0.18],
              scaleX: [0.92, 1.04, 0.92],
            }}
            transition={{
              duration: 2.8,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          />

          <motion.div
            className="absolute left-[-22%] top-1/2 h-[34%] w-[144%] -translate-y-1/2"
            animate={{
              x: [0, isSpeaking ? 10 : 6, 0],
              opacity: [0.7, 1, 0.7],
            }}
            transition={{
              duration: waveDuration,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          >
            {WAVE_POINTS.map((point) => (
              <motion.span
                key={point.id}
                className="absolute rounded-full"
                style={{
                  left: `${point.x}%`,
                  top: `${point.baseY}%`,
                  width: `${point.size - 0.2}px`,
                  height: `${point.size - 0.2}px`,
                  background:
                    point.id % 2 === 0
                      ? "rgba(56, 189, 248, 0.88)"
                      : "rgba(217, 70, 239, 0.8)",
                  boxShadow:
                    point.id % 2 === 0
                      ? "0 0 10px rgba(56,189,248,0.8)"
                      : "0 0 10px rgba(217,70,239,0.7)",
                }}
                animate={{
                  y: [point.baseY - 50, point.altY - 50, point.baseY - 50].map(
                    (value) => value + (isSpeaking ? waveTravel : waveTravel * 0.65)
                  ),
                  opacity: [0.35, 1, 0.35],
                  scale: isSpeaking ? [0.86, 1.35, 0.86] : [0.86, 1.14, 0.86],
                }}
                transition={{
                  duration: waveDuration,
                  delay: point.delay * 0.18,
                  repeat: Infinity,
                  ease: "easeInOut",
                }}
              />
            ))}
          </motion.div>

          <motion.div
            className="absolute left-[-18%] top-1/2 h-[18%] w-[136%] -translate-y-1/2"
            animate={{
              x: [0, isSpeaking ? -8 : -4, 0],
              opacity: [0.12, 0.28, 0.12],
            }}
            transition={{
              duration: waveDuration * 1.2,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          >
            {WAVE_POINTS.filter((point) => point.id % 2 === 0).map((point) => (
              <motion.span
                key={`echo-${point.id}`}
                className="absolute rounded-full bg-cyan-200/80"
                style={{
                  left: `${point.x}%`,
                  top: `${48 + Math.sin((point.x / 100) * Math.PI * 4 + 1.4) * 6}%`,
                  width: "1.2px",
                  height: "1.2px",
                  boxShadow: "0 0 8px rgba(125,211,252,0.45)",
                }}
                animate={{
                  y: [0, isSpeaking ? -7 : -4, 0],
                  opacity: [0.1, 0.45, 0.1],
                }}
                transition={{
                  duration: waveDuration * 1.15,
                  delay: point.delay * 0.12,
                  repeat: Infinity,
                  ease: "easeInOut",
                }}
              />
            ))}
          </motion.div>

          <motion.div
            className="absolute left-[-18%] top-1/2 h-[28%] w-[136%] -translate-y-1/2"
            style={{
              background:
                "linear-gradient(90deg, rgba(34,211,238,0) 0%, rgba(34,211,238,0.08) 20%, rgba(217,70,239,0.12) 50%, rgba(34,211,238,0.08) 80%, rgba(34,211,238,0) 100%)",
              filter: "blur(12px)",
            }}
            animate={{
              x: [0, isSpeaking ? 14 : 8, 0],
              opacity: [0.22, 0.42, 0.22],
            }}
            transition={{
              duration: waveDuration,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          />
        </div>

        <motion.div
          className="absolute inset-[-2%] rounded-full border border-cyan-300/30"
          animate={{
            scale: [0.985, 1.02, 0.985],
            opacity: [0.16, 0.3, 0.16],
          }}
          transition={{
            duration: 2.6,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />
      </motion.div>
    </div>
  );
}
