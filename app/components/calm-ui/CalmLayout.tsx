"use client";

import InterviewHeader from "./InterviewHeader";
import CameraPanel from "./CameraPanel";
import OrbQuestion from "@/app/components/calm/OrbQuestion";
import TelemetryIndicators from "./TelemetryIndicators";

export default function CalmLayout() {
  return (
    <div className="h-[100dvh] w-full bg-black text-white flex flex-col overflow-hidden">

      {/* HEADER */}
      <div className="h-[80px] flex-shrink-0 border-b border-white/10">
        <InterviewHeader />
      </div>

      {/* MAIN CONTENT */}
        <div className="flex-1 flex flex-col items-center justify-start pt-6 gap-8">
        {/* CAMERA */}
        <div className="flex flex-col items-center">
          <CameraPanel />
<       div className="w-[300px] h-[1px] bg-white/5 mt-4 mb-2" />
          {/* ✅ TELEMETRY BELOW CAMERA */}
          <div className="mt-4">
            <TelemetryIndicators />
          </div>
        </div>

        {/* ORB CENTER */}
        <div className="flex items-center justify-center w-full flex-1">
        <OrbQuestion />
        </div>

      </div>
    </div>
  );
}