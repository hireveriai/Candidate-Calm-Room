"use client";

import InterviewHeader from "./InterviewHeader";
import CameraPanel from "./CameraPanel";
import TelemetryIndicators from "./TelemetryIndicators";

export default function CalmLayout() {
  return (
    <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-black text-white">
      <div className="h-[80px] flex-shrink-0 border-b border-white/10">
        <InterviewHeader />
      </div>

      <div className="flex flex-1 flex-col items-center justify-start gap-8 pt-6">
        <div className="flex flex-col items-center">
          <CameraPanel />
          <div className="mt-4 h-px w-[300px] bg-white/5" />
          <div className="mt-4">
            <TelemetryIndicators />
          </div>
        </div>
      </div>
    </div>
  );
}
