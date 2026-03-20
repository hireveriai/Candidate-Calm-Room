"use client";

import clsx from "clsx";
import { Mic, Eye, Shield, User, Volume2 } from "lucide-react";

type Props = {
  faceDetected: boolean;
  micActive: boolean;
  attention: boolean;
  secure: boolean;
  verisState: "idle" | "listening" | "thinking" | "speaking";
};

function Pill({
  active,
  label,
  icon,
  color,
}: {
  active: boolean;
  label: string;
  icon: React.ReactNode;
  color: string;
}) {
  return (
    <div
      className={clsx(
        "flex items-center gap-2 px-3 py-1.5 rounded-full text-xs transition-all",
        "border backdrop-blur-sm",
        active
          ? `${color} border-transparent shadow-md`
          : "bg-white/5 text-gray-400 border-white/10"
      )}
    >
      {icon}
      {label}
    </div>
  );
}

export default function SystemIndicators({
  faceDetected,
  micActive,
  attention,
  secure,
  verisState,
}: Props) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 mt-4">

      {/* 🟢 Face */}
      <Pill
        active={faceDetected}
        label="Face Detected"
        icon={<User size={14} />}
        color="bg-green-500/20 text-green-300"
      />

      {/* 🎤 Mic */}
      <Pill
        active={micActive}
        label="Microphone Active"
        icon={<Mic size={14} />}
        color="bg-cyan-500/20 text-cyan-300"
      />

      {/* 👁️ Attention */}
      <Pill
        active={attention}
        label="Attention Tracking"
        icon={<Eye size={14} />}
        color="bg-purple-500/20 text-purple-300"
      />

      {/* 🔒 Secure */}
      <Pill
        active={secure}
        label="Secure Mode"
        icon={<Shield size={14} />}
        color="bg-white/20 text-white"
      />

      {/* 🎧 Veris Listening */}
      <Pill
        active={verisState === "listening"}
        label="Veris Listening"
        icon={<Mic size={14} />}
        color="bg-blue-500/20 text-blue-300"
      />

      {/* 🗣️ Veris Speaking */}
      <Pill
        active={verisState === "speaking"}
        label="Veris Speaking"
        icon={<Volume2 size={14} />}
        color="bg-violet-500/20 text-violet-300"
      />
    </div>
  );
}