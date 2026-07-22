"use client";

import Image from "next/image";
import { Copy } from "lucide-react";
import { type DragEvent, useEffect, useRef, useState } from "react";

import { exportCollatedPdf } from "@/lib/export-collated-pdf";
import { exportCollatedPowerpoint } from "@/lib/export-collated-powerpoint";
import {
  parseNovoExpressReport,
  type ParsedReport,
  type ParseProgress,
} from "@/lib/novoexpress-parser";

const initialProgress: ParseProgress = {
  currentPage: 0,
  pageCount: 0,
  percent: 0,
  stage: "Waiting for a report",
};

const PLOT_COLUMNS = 5;
const APP_BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(
  /\/+$/,
  "",
);

type ReportView = "groups" | "samples";
type ExportFormat = "pdf" | "powerpoint";
type CopyStatus = "copying" | "copied" | "error";

type CopyFeedback = {
  plotId: string;
  status: CopyStatus;
};

function imageUrlToPngBlob(imageUrl: string) {
  return new Promise<Blob>((resolve, reject) => {
    const image = new window.Image();

    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");

      if (!context) {
        reject(new Error("The browser could not prepare this plot for copying."));
        return;
      }

      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0);
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("The browser could not create a copyable image."));
        }
      }, "image/png");
    };

    image.onerror = () => {
      reject(new Error("The plot image could not be read."));
    };
    image.src = imageUrl;
  });
}

async function copyPlotImage(imageUrl: string) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Image copying is not supported in this browser.");
  }

  if (
    typeof ClipboardItem.supports === "function" &&
    !ClipboardItem.supports("image/png")
  ) {
    throw new Error("PNG clipboard images are not supported in this browser.");
  }

  await navigator.clipboard.write([
    new ClipboardItem({
      "image/png": imageUrlToPngBlob(imageUrl),
    }),
  ]);
}

export function ReportCollator() {
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const copyFeedbackTimeoutRef = useRef<number | null>(null);
  const [report, setReport] = useState<ParsedReport | null>(null);
  const [progress, setProgress] = useState<ParseProgress>(initialProgress);
  const [error, setError] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [view, setView] = useState<ReportView>("groups");
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback | null>(null);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimeoutRef.current !== null) {
        window.clearTimeout(copyFeedbackTimeoutRef.current);
      }
    };
  }, []);

  function clearCopyFeedback() {
    if (copyFeedbackTimeoutRef.current !== null) {
      window.clearTimeout(copyFeedbackTimeoutRef.current);
      copyFeedbackTimeoutRef.current = null;
    }
    setCopyFeedback(null);
  }

  function showCopyResult(plotId: string, status: "copied" | "error") {
    setCopyFeedback({ plotId, status });
    copyFeedbackTimeoutRef.current = window.setTimeout(
      () => {
        copyFeedbackTimeoutRef.current = null;
        setCopyFeedback(null);
      },
      status === "copied" ? 1800 : 4000,
    );
  }

  async function processFile(file?: File) {
    if (!file) {
      return;
    }

    setError(null);
    setReport(null);
    setProgress(initialProgress);
    setIsParsing(true);
    clearCopyFeedback();

    try {
      setReport(await parseNovoExpressReport(file, setProgress));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The report could not be parsed in this browser.",
      );
    } finally {
      setIsParsing(false);
    }
  }

  function reset() {
    setReport(null);
    setError(null);
    setProgress(initialProgress);
    setView("groups");
    clearCopyFeedback();
    dragDepthRef.current = 0;
    setIsDragging(false);
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  }

  function isFileDrag(event: DragEvent<HTMLFieldSetElement>) {
    return event.dataTransfer.types.includes("Files");
  }

  function handleDragEnter(event: DragEvent<HTMLFieldSetElement>) {
    if (!isFileDrag(event)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    setIsDragging(true);
  }

  function handleDragOver(event: DragEvent<HTMLFieldSetElement>) {
    if (!isFileDrag(event)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setIsDragging(true);
  }

  function handleDragLeave(event: DragEvent<HTMLFieldSetElement>) {
    if (!isFileDrag(event)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragging(false);
    }
  }

  function handleDrop(event: DragEvent<HTMLFieldSetElement>) {
    if (!isFileDrag(event)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setIsDragging(false);
    void processFile(event.dataTransfer.files[0]);
  }

  async function handleExport(format: ExportFormat) {
    if (!report) {
      return;
    }

    setExportFormat(format);
    setError(null);
    try {
      if (format === "pdf") {
        await exportCollatedPdf(report, PLOT_COLUMNS);
      } else {
        await exportCollatedPowerpoint(report);
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : `The grouped ${
              format === "pdf" ? "PDF" : "PowerPoint"
            } could not be generated.`,
      );
    } finally {
      setExportFormat(null);
    }
  }

  async function handleCopyPlot(plotId: string, imageUrl: string) {
    clearCopyFeedback();
    setCopyFeedback({ plotId, status: "copying" });

    try {
      await copyPlotImage(imageUrl);
      showCopyResult(plotId, "copied");
    } catch {
      showCopyResult(plotId, "error");
    }
  }

  return (
    <main className="site-shell">
      <header className="site-header">
        <div className="site-header__inner">
          <Image
            className="site-logo"
            src={`${APP_BASE_PATH}/favicon.ico`}
            alt=""
            width={40}
            height={40}
            unoptimized
          />
          <h1>Flow cytometry report collator</h1>
        </div>
      </header>

      {!report && (
        <fieldset
          className={`drop-zone${isDragging ? " is-dragging" : ""}`}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <legend>Open a PDF</legend>
          {isParsing ? (
            <div className="parse-progress" aria-live="polite">
              <label htmlFor="parse-progress">{progress.stage}</label>
              <progress
                id="parse-progress"
                max="100"
                value={progress.percent}
              />
              <span>
                Progress: {progress.percent}%
                {progress.pageCount > 0
                  ? `, page ${progress.currentPage} of ${progress.pageCount}`
                  : ""}
              </span>
            </div>
          ) : (
            <div className="file-row">
              <input
                ref={inputRef}
                type="file"
                accept="application/pdf,.pdf"
                aria-label="Choose a flow cytometry PDF report"
                onChange={(event) =>
                  void processFile(event.currentTarget.files?.[0])
                }
              />
              <span>or drop a file here</span>
            </div>
          )}
        </fieldset>
      )}

      {error && (
        <section className="message error-message" role="alert">
          <strong>Error:</strong> {error}
        </section>
      )}

      {report && (
        <>
          <section className="report-summary" aria-label="Report summary">
            <dl className="report-metadata" aria-label="Report details">
              <div>
                <dt>File name</dt>
                <dd>{report.metadata.fileName ?? report.fileName}</dd>
              </div>
              <div>
                <dt>Cytometer</dt>
                <dd>{report.metadata.cytometer ?? "Not listed"}</dd>
              </div>
              <div>
                <dt>Run time</dt>
                <dd>{report.metadata.runTime ?? "Not listed"}</dd>
              </div>
              <div>
                <dt>Software</dt>
                <dd>{report.metadata.software ?? "Not listed"}</dd>
              </div>
            </dl>
            <dl className="report-summary__counts" aria-label="Report contents">
              <div>
                <dt>Pages</dt>
                <dd>{report.pageCount}</dd>
              </div>
              <div>
                <dt>Samples</dt>
                <dd>{report.sampleNames.length}</dd>
              </div>
              <div>
                <dt>Plots</dt>
                <dd>{report.plots.length}</dd>
              </div>
              <div>
                <dt>Groups</dt>
                <dd>{report.groups.length}</dd>
              </div>
            </dl>
          </section>

          {report.warnings.length > 0 && (
            <details className="message parser-notes" open>
              <summary>
                Review {report.warnings.length} parser note
                {report.warnings.length === 1 ? "" : "s"}
              </summary>
              <ul>
                {report.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </details>
          )}

          <section className="report-controls" aria-label="Report controls">
            <nav className="view-switcher" aria-label="Report view">
              <button
                type="button"
                className={view === "groups" ? "is-active" : undefined}
                aria-pressed={view === "groups"}
                onClick={() => setView("groups")}
              >
                Grouped plots
              </button>
              <button
                type="button"
                className={view === "samples" ? "is-active" : undefined}
                aria-pressed={view === "samples"}
                onClick={() => setView("samples")}
              >
                Samples
              </button>
            </nav>
            <div className="toolbar-actions">
              <button type="button" onClick={reset}>
                New report
              </button>
              <select
                aria-label="Export report"
                value=""
                disabled={exportFormat !== null}
                onChange={(event) => {
                  const format = event.currentTarget.value as ExportFormat;
                  void handleExport(format);
                }}
              >
                <option value="" disabled>
                  {exportFormat ? "Exporting…" : "Export"}
                </option>
                <option value="pdf">Export as PDF</option>
                <option value="powerpoint">Export as PowerPoint</option>
              </select>
            </div>
          </section>

          {view === "groups" ? (
            <div className="plot-groups">
              {report.groups.map((group) => (
                <section className="plot-group" key={group.key}>
                  <header className="plot-group__header">
                    <h2>Plot: {group.label}</h2>
                    <dl className="plot-group__details">
                      <div>
                        <dt>Samples shown</dt>
                        <dd>
                          {
                            new Set(
                              group.plots.map((plot) => plot.sampleName),
                            ).size
                          }
                        </dd>
                      </div>
                      <div>
                        <dt>Input population</dt>
                        <dd>
                          {group.parentPath === "All events"
                            ? "All collected events"
                            : group.parentPath}
                        </dd>
                      </div>
                    </dl>
                  </header>
                  <div className="plot-grid">
                    {group.plots.map((plot) => (
                      <figure key={plot.id}>
                        <div className="plot-image">
                          {/* PDF crops are generated in-memory and have no stable URL for next/image. */}
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={plot.imageUrl}
                            alt={`${group.label} plot for ${plot.sampleName}`}
                          />
                          <button
                            type="button"
                            className={`plot-copy-button${
                              copyFeedback?.plotId === plot.id
                                ? " has-label"
                                : ""
                            }`}
                            aria-label={
                              copyFeedback?.plotId === plot.id
                                ? copyFeedback.status === "copying"
                                  ? `Copying ${group.label} plot for ${plot.sampleName}`
                                  : copyFeedback.status === "copied"
                                    ? `Copied ${group.label} plot for ${plot.sampleName}`
                                    : `Copy failed for ${group.label} plot for ${plot.sampleName}`
                                : `Copy ${group.label} plot for ${plot.sampleName}`
                            }
                            title={
                              copyFeedback?.plotId === plot.id &&
                              copyFeedback.status === "error"
                                ? "Copy failed — right-click the image"
                                : "Copy plot image"
                            }
                            disabled={copyFeedback?.status === "copying"}
                            onClick={() =>
                              void handleCopyPlot(plot.id, plot.imageUrl)
                            }
                          >
                            {copyFeedback?.plotId === plot.id ? (
                              <span aria-live="polite">
                                {copyFeedback.status === "copying"
                                  ? "Copying…"
                                  : copyFeedback.status === "copied"
                                    ? "Copied"
                                    : "Copy failed"}
                              </span>
                            ) : (
                              <Copy aria-hidden="true" />
                            )}
                          </button>
                        </div>
                        <figcaption>
                          <dl>
                            <div className="plot-caption__sample">
                              <dt>Sample</dt>
                              <dd title={plot.sampleName}>{plot.sampleName}</dd>
                            </div>
                            <div>
                              <dt>Gate</dt>
                              <dd>{plot.gateName}</dd>
                            </div>
                            <div>
                              <dt>Page</dt>
                              <dd>{plot.pageNumber}</dd>
                            </div>
                          </dl>
                        </figcaption>
                      </figure>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <section className="sample-section">
              <h2>Samples</h2>
              <ol className="sample-list">
                {report.sampleNames.map((sampleName) => (
                  <li key={sampleName} title={sampleName}>
                    {sampleName}
                  </li>
                ))}
              </ol>
            </section>
          )}
        </>
      )}
    </main>
  );
}
