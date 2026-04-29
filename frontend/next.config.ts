import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "profile.img.sooplive.co.kr",
      },
    ],
  },
};

export default nextConfig;
