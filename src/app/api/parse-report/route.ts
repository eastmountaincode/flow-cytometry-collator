import { createCanvas } from "@napi-rs/canvas";

import {
  parseNovoExpressReport,
  type ParserCanvasFactory,
  type ReportFile,
} from "@/lib/novoexpress-parser";
import { MAX_REPORT_BYTES } from "@/lib/report-limits";
import { serializeReport } from "@/lib/report-transport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const responseHeaders = {
  "Cache-Control": "no-store, private",
  "X-Content-Type-Options": "nosniff",
};

function errorResponse(message: string, status: number) {
  return Response.json(
    { error: message },
    {
      status,
      headers: responseHeaders,
    },
  );
}

function reportFileName(request: Request) {
  const encodedName = request.headers.get("x-report-file-name");
  if (!encodedName) {
    return "report.pdf";
  }

  try {
    const decodedName = decodeURIComponent(encodedName);
    return decodedName.split(/[\\/]/).pop() || "report.pdf";
  } catch {
    return "report.pdf";
  }
}

const createServerCanvas: ParserCanvasFactory = (width, height) =>
  createCanvas(width, height) as unknown as HTMLCanvasElement;

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/pdf")) {
    return errorResponse("Choose a PDF report exported from NovoExpress.", 415);
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REPORT_BYTES) {
    return errorResponse(
      "This PDF is larger than 300 MB. Split the NovoExpress report first.",
      413,
    );
  }

  const data = await request.arrayBuffer();
  if (data.byteLength === 0) {
    return errorResponse("The selected PDF is empty.", 400);
  }
  if (data.byteLength > MAX_REPORT_BYTES) {
    return errorResponse(
      "This PDF is larger than 300 MB. Split the NovoExpress report first.",
      413,
    );
  }

  const file: ReportFile = {
    name: reportFileName(request),
    type: "application/pdf",
    size: data.byteLength,
    arrayBuffer: async () => data,
  };

  try {
    const report = await parseNovoExpressReport(file, () => undefined, {
      createCanvas: createServerCanvas,
    });
    return Response.json(serializeReport(report), { headers: responseHeaders });
  } catch (cause) {
    const message =
      cause instanceof Error
        ? cause.message
        : "The report could not be parsed on the server.";
    return errorResponse(message, 422);
  }
}
