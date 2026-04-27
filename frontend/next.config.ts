import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
