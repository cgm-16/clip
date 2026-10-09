import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Mono carries machine values only — channels, roles, timestamps, permission
// constants, slash commands. `--font-mono` in globals.css composes this
// generated family in front of the token's fallbacks.
//
// The UI face is Pretendard, which Google Fonts does not serve and which this
// repository does not vendor, so no second webfont is loaded: `--font-ui`
// resolves through the stack the token already declares.
//
// JetBrains Mono is vendored (app/fonts, OFL-licensed) rather than loaded through
// next/font/google, which downloads Google's stylesheet at build time and
// fails the build when that response does not parse (#70). The file is the
// Latin subset Google serves: one variable font covering weights 400 and 500.
const jetBrainsMono = localFont({
  src: "./fonts/JetBrainsMono-latin.woff2",
  variable: "--font-jetbrains-mono",
  weight: "400 500",
  display: "swap",
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
      className={jetBrainsMono.variable}
    >
      <body>{children}</body>
    </html>
  );
}
