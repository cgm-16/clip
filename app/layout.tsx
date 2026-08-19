import type { Metadata, Viewport } from "next";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Mono carries machine values only — channels, roles, timestamps, permission
// constants, slash commands. `--font-mono` in globals.css composes this
// generated family in front of the token's fallbacks.
//
// The UI face is Pretendard, which Google Fonts does not serve and which this
// repository does not vendor, so no second webfont is loaded: `--font-ui`
// resolves through the stack the token already declares.
const jetBrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
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
      className={`${jetBrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
