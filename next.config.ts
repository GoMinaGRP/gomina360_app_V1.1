import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    "*.e2b.app",
    "127.0.0.1",
    "localhost",
  ],
};

export default nextConfig;
