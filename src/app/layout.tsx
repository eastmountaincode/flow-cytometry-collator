import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Flow cytometry report collator",
  description:
    "Group matching plots from flow cytometry PDF reports without uploading lab data.",
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
