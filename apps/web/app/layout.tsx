import type { Metadata } from "next";
import { IBM_Plex_Mono, Manrope } from "next/font/google";
import "./globals.css";

const sansFont = Manrope({
  subsets: ["latin"],
  variable: "--font-sans",
});

const monoFont = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "ClaimFlow",
  description: "Warranty claim intake and processing",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${sansFont.variable} ${monoFont.variable}`}>{children}</body>
    </html>
  );
}
