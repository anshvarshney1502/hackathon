import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  // Extra local "players" during dev: http://127.0.0.1:3000 and http://[::1]:3000 each get their own localStorage.
  allowedDevOrigins: ["127.0.0.1", "::1", "[::1]"],
  poweredByHeader: false,
  // Production has one public address. Per-deployment *.vercel.app URLs redirect to it, so invite links are always shareable.
  async redirects() {
    if (process.env.VERCEL_ENV !== "production") return [];
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "(?!hackathon-phi-lemon\\.vercel\\.app$).+\\.vercel\\.app" }],
        destination: "https://hackathon-phi-lemon.vercel.app/:path*",
        permanent: false,
      },
    ];
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
