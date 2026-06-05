import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { Analytics } from "@vercel/analytics/react";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "엑셀 크루 낙수표 | SOOP 숲 별풍선 낙수표",
  description:
    "SOOP 숲 크루별 개인 방송 별풍선 낙수표, 크루원 점수, 후원자 리스트, 월간 낙수 랭킹을 확인할 수 있는 엑셀 크루 낙수표입니다.",
  keywords: [
    "엑셀 크루 낙수표",
    "크루 낙수표",
    "SOOP",
    "숲",
    "별풍선",
    "낙수표",
    "크루별 낙수표",
    "아프리카TV",
    "풍고",
  ],
  openGraph: {
    title: "엑셀 크루 낙수표 | SOOP 숲 별풍선 낙수표",
    description:
      "SOOP 숲 크루별 개인 방송 별풍선 낙수표와 후원자 리스트를 확인하세요.",
    type: "website",
    locale: "ko_KR",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ko"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <Analytics />
        <Script
          src="https://unpkg.com/boxicons@2.1.4/dist/boxicons.js"
          strategy="afterInteractive"
        />
      </body>
    </html>
  );
}
