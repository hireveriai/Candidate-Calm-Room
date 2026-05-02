import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Interview Room",
  description: "HireVeri interview room",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
