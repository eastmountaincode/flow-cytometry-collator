import type { NextConfig } from "next";

const configuredBasePath = process.env.NEXT_PUBLIC_BASE_PATH?.trim() ?? "";
const basePath =
  configuredBasePath === "/"
    ? ""
    : configuredBasePath.replace(/\/+$/, "");

if (basePath && !basePath.startsWith("/")) {
  throw new Error("NEXT_PUBLIC_BASE_PATH must start with a forward slash.");
}

const nextConfig: NextConfig = {
  basePath,
  output: "standalone",
  outputFileTracingIncludes: {
    "/api/parse-report": [
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
    ],
  },
  serverExternalPackages: ["@napi-rs/canvas", "pdfjs-dist"],
  trailingSlash: true,
};

export default nextConfig;
