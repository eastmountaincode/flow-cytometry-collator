import type { Metadata } from "next";
import "./globals.css";

const appBasePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(
  /\/+$/,
  "",
);

export const metadata: Metadata = {
  title: "Flow cytometry report collator",
  description:
    "Group matching plots from flow cytometry PDF reports without uploading lab data.",
  icons: {
    icon: `${appBasePath}/favicon.ico`,
  },
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
