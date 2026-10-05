import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { DEFAULT_LANG, LANG_COOKIE, isLangCode } from "@/lib/i18n/config";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#eefdf4",
};

export const metadata: Metadata = {
  title: "Gyanzo — Turn PDFs into Understanding",
  description:
    "Put any PDF into Gyanzo, and Gyanzo AI turns the information inside it into summaries, key takeaways and answers you can understand.",
  keywords: ["Gyanzo", "PDF AI", "AI understanding", "study app", "summarize PDF"],
  authors: [{ name: "Gyanzo" }],
  // Favicon: robot mascot — served from file conventions in src/app/
  // (favicon.ico + icon.png + apple-icon.png, auto-linked by Next.js).
  openGraph: {
    title: "Gyanzo — Turn PDFs into Understanding",
    description: "A confusing PDF goes in → Gyanzo AI understands it → knowledge becomes simple.",
    siteName: "Gyanzo",
    type: "website",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Localize <html lang> from the persisted language cookie (a11y + SEO).
  const store = await cookies();
  const raw = store.get(LANG_COOKIE)?.value;
  const lang = isLangCode(raw) ? raw : DEFAULT_LANG;

  return (
    <html lang={lang} suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {/* Poppins for the landing page, intro and auth cards;
            Noto Sans Devanagari covers Hindi/Marathi glyphs
            (graceful fallback if offline) */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- App Router: root layout link applies to all routes */}
        <link
          href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&family=Noto+Sans+Devanagari:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        {children}
        <Toaster />
      </body>
    </html>
  );
}
