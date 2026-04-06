import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
