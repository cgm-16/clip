import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Clip",
  description: "서버가 소유하는 아카이브에 메시지를 보존합니다.",
  // Every surface is admin-only behind a short-lived session. Nothing here
  // should be indexed.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  // Dark is canonical for P0. The light tokens exist but are not exposed.
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="ko"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
