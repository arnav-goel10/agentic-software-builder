import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dexter — Describe it. Watch it get built.",
  description:
    "Dexter turns a short brief into a working web app: spec, plan, scaffold, code, and validate, with every phase gated and every file accounted for.",
  keywords: ["app builder", "code generation", "agent engine", "software prototyping"],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="font-sans antialiased bg-[#fafafa] text-[#1d1d1f] overflow-x-hidden" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
