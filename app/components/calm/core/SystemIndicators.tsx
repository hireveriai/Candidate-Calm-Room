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
    <div className="mt-4 flex w-full items-center justify-center gap-6 text-xs text-white/70">
      <div className="flex items-center gap-1">
        {faceCount === 1 && (
          <span className="text-white/80">Face Detected</span>
        )}
        {faceCount === 0 && (
          <span className="text-yellow-400">No Face Detected</span>
        )}
        {faceCount > 1 && (
          <span className="text-red-400">Ensure only you are visible</span>
        )}
      </div>

      <div className="flex items-center gap-1">
        {micActive ? (
          <span className="text-green-400">Mic Active</span>
        ) : (
          <span className="text-white/40">Mic Off</span>
        )}
      </div>

      <div className="flex items-center gap-1">
        {attention ? (
          <span className="text-white/80">Focused</span>
        ) : (
          <span className="text-yellow-400">Stay focused on the screen</span>
        )}
      </div>

      <div className="flex items-center gap-1">
        {secure && <span className="text-white/60">Secure</span>}
      </div>

      <div className="flex items-center gap-1">
        {verisState === "speaking" && (
          <span className="text-blue-400">Veris is asking a question</span>
        )}
        {verisState === "listening" && (
          <span className="text-green-400">Veris Listening</span>
        )}
        {verisState === "thinking" && (
          <span className="text-white/50">Thinking</span>
        )}
      </div>
    </div>
  );
}
