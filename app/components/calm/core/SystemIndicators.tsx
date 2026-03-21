"use client";

type VerisState = "idle" | "listening" | "thinking" | "speaking";

type Props = {
  faceCount: number;
  micActive: boolean;
  attention: boolean;
  secure: boolean;
  verisState: VerisState;
};

export default function SystemIndicators({
  faceCount,
  micActive,
  attention,
  secure,
  verisState,
}: Props) {
  return (
    <div className="w-full flex items-center justify-center gap-6 mt-4 text-xs text-white/70">

      {/* 👤 FACE STATUS */}
      <div className="flex items-center gap-1">
        {faceCount === 1 && (
          <span className="text-white/80">👤 Face Detected</span>
        )}
        {faceCount === 0 && (
          <span className="text-yellow-400">⚠️ No Face Detected</span>
        )}
        {faceCount > 1 && (
          <span className="text-red-400">🚨 Multiple Faces</span>
        )}
      </div>

      {/* 🎤 MIC */}
      <div className="flex items-center gap-1">
        {micActive ? (
          <span className="text-green-400">🎤 Mic Active</span>
        ) : (
          <span className="text-white/40">🎤 Mic Off</span>
        )}
      </div>

      {/* 👁️ ATTENTION */}
      <div className="flex items-center gap-1">
        {attention ? (
          <span className="text-white/80">👁️ Focused</span>
        ) : (
          <span className="text-yellow-400">⚠️ Looking Away</span>
        )}
      </div>

      {/* 🔒 SECURE MODE */}
      <div className="flex items-center gap-1">
        {secure && (
          <span className="text-white/60">🔒 Secure</span>
        )}
      </div>

      {/* 🤖 VERIS STATE */}
      <div className="flex items-center gap-1">
        {verisState === "speaking" && (
          <span className="text-blue-400">🗣️ Veris Speaking</span>
        )}
        {verisState === "listening" && (
          <span className="text-green-400">🎧 Veris Listening</span>
        )}
        {verisState === "thinking" && (
          <span className="text-white/50">💭 Thinking</span>
        )}
      </div>

    </div>
  );
}