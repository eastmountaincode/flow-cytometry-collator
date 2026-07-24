import { createCanvas } from "@napi-rs/canvas";

import {
  parseNovoExpressReport,
  type ParserCanvasFactory,
  type ReportFile,
} from "@/lib/novoexpress-parser";
import { MAX_REPORT_BYTES } from "@/lib/report-limits";
import {
  serializeReport,
  type ParseReportStreamEvent,
} from "@/lib/report-transport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const responseHeaders = {
  "Cache-Control": "no-store, private",
  "X-Content-Type-Options": "nosniff",
};

const streamResponseHeaders = {
  ...responseHeaders,
  "Content-Encoding": "identity",
  "Content-Type": "application/x-ndjson; charset=utf-8",
};

const streamEncoder = new TextEncoder();

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

function errorMessage(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "The report could not be parsed on the server.";
}

function encodeStreamEvent(event: ParseReportStreamEvent) {
  return streamEncoder.encode(`${JSON.stringify(event)}\n`);
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID().slice(0, 8);
  const startedAt = Date.now();
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  const declaredLength = Number(request.headers.get("content-length"));

  console.info("[parse-report] request received", {
    requestId,
    declaredBytes: Number.isFinite(declaredLength) ? declaredLength : null,
  });

  if (!contentType.startsWith("application/pdf")) {
    console.warn("[parse-report] request rejected", {
      requestId,
      reason: "unsupported content type",
    });
    return errorResponse("Choose a PDF report exported from NovoExpress.", 415);
  }

  if (Number.isFinite(declaredLength) && declaredLength > MAX_REPORT_BYTES) {
    console.warn("[parse-report] request rejected", {
      requestId,
      reason: "declared file size exceeds limit",
      declaredBytes: declaredLength,
    });
    return errorResponse(
      "This PDF is larger than 300 MB. Split the NovoExpress report first.",
      413,
    );
  }

  let data: ArrayBuffer;
  try {
    data = await request.arrayBuffer();
  } catch (cause) {
    console.error("[parse-report] upload failed", {
      requestId,
      error: errorMessage(cause),
    });
    return errorResponse("The PDF upload did not finish. Try it again.", 400);
  }

  if (data.byteLength === 0) {
    console.warn("[parse-report] request rejected", {
      requestId,
      reason: "empty upload",
    });
    return errorResponse("The selected PDF is empty.", 400);
  }
  if (data.byteLength > MAX_REPORT_BYTES) {
    console.warn("[parse-report] request rejected", {
      requestId,
      reason: "uploaded file size exceeds limit",
      uploadedBytes: data.byteLength,
    });
    return errorResponse(
      "This PDF is larger than 300 MB. Split the NovoExpress report first.",
      413,
    );
  }

  console.info("[parse-report] upload received", {
    requestId,
    uploadedBytes: data.byteLength,
    elapsedMs: Date.now() - startedAt,
  });

  const file: ReportFile = {
    name: reportFileName(request),
    type: "application/pdf",
    size: data.byteLength,
    arrayBuffer: async () => data,
  };

  const abortController = new AbortController();
  let streamCanceled = false;
  let lastLoggedPage = 0;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        try {
          const report = await parseNovoExpressReport(
            file,
            (progress) => {
              if (streamCanceled) {
                return;
              }

              const streamedProgress =
                progress.percent === 100
                  ? {
                      ...progress,
                      percent: 95,
                      stage: "Preparing report",
                    }
                  : progress;
              controller.enqueue(
                encodeStreamEvent({
                  type: "progress",
                  progress: streamedProgress,
                }),
              );

              if (
                progress.currentPage > 0 &&
                progress.currentPage !== lastLoggedPage &&
                (progress.currentPage === progress.pageCount ||
                  progress.currentPage - lastLoggedPage >= 10)
              ) {
                lastLoggedPage = progress.currentPage;
                console.info("[parse-report] parsing", {
                  requestId,
                  page: progress.currentPage,
                  pages: progress.pageCount,
                  elapsedMs: Date.now() - startedAt,
                });
              }
            },
            {
              createCanvas: createServerCanvas,
              signal: abortController.signal,
            },
          );

          if (streamCanceled) {
            return;
          }

          controller.enqueue(
            encodeStreamEvent({
              type: "report",
              report: serializeReport(report),
            }),
          );
          console.info("[parse-report] completed", {
            requestId,
            pages: report.pageCount,
            plots: report.plots.length,
            groups: report.groups.length,
            elapsedMs: Date.now() - startedAt,
          });
        } catch (cause) {
          if (streamCanceled || abortController.signal.aborted) {
            console.info("[parse-report] canceled", {
              requestId,
              elapsedMs: Date.now() - startedAt,
            });
            return;
          }

          const message = errorMessage(cause);
          console.error("[parse-report] failed", {
            requestId,
            error: message,
            elapsedMs: Date.now() - startedAt,
          });
          controller.enqueue(
            encodeStreamEvent({
              type: "error",
              message,
            }),
          );
        } finally {
          if (!streamCanceled) {
            controller.close();
          }
        }
      })();
    },
    cancel() {
      streamCanceled = true;
      abortController.abort();
    },
  });

  return new Response(stream, {
    headers: streamResponseHeaders,
  });
}
