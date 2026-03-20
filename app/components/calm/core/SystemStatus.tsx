"use client";

import { Mic, Video } from "lucide-react";

export default function SystemStatus() {
  return (
    <div className="absolute bottom-4 right-4 flex gap-3 text-gray-400">
      <Mic size={18} />
      <Video size={18} />
    </div>
  );
}