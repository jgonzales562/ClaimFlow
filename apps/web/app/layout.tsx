import type { Metadata } from "next";
import "./globals.css";

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
      <body>{children}</body>
    </html>
  );
}
