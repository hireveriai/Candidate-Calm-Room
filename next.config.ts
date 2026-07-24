import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Recording recovery compresses large interview videos before transcription.
  // Explicit tracing keeps the platform-specific FFmpeg binary inside every
  // server function that may run completion or watchdog recovery.
  outputFileTracingIncludes: {
    "/api/interview/watchdog": [
      "./node_modules/ffmpeg-static/ffmpeg",
      "./node_modules/ffmpeg-static/ffmpeg.exe",
    ],
    "/api/session/complete": [
      "./node_modules/ffmpeg-static/ffmpeg",
      "./node_modules/ffmpeg-static/ffmpeg.exe",
    ],
    "/api/session/next-question": [
      "./node_modules/ffmpeg-static/ffmpeg",
      "./node_modules/ffmpeg-static/ffmpeg.exe",
    ],
    "/api/session/terminate": [
      "./node_modules/ffmpeg-static/ffmpeg",
      "./node_modules/ffmpeg-static/ffmpeg.exe",
    ],
  },
  experimental: {
    cpus: 1,
  },
  turbopack: {
    root: process.cwd(),
  },
  typescript: {
    // `tsc --noEmit` runs in the build script; skipping Next's internal worker
    // avoids a Windows `spawn EPERM` failure in this environment.
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
