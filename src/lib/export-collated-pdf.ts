import type { ParsedPlot, ParsedReport } from "@/lib/novoexpress-parser";
import {
  getExportPages,
  type ExportGrouping,
} from "@/lib/export-grouping";
import {
  displayedGateLabel,
  formatDisplayedGates,
  formatInputPopulations,
} from "@/lib/report-labels";

const COLUMNS = 3;
const ROWS = 2;
const CARD_PADDING = 7;
const CAPTION_LABEL_WIDTH = 60;
const CAPTION_COLUMN_GAP = 4;
const CAPTION_FONT_SIZE = 7.5;
const CAPTION_LINE_HEIGHT = 9;
const CAPTION_FIELD_GAP = 2;

type MetadataField = {
  label: string;
  value: string;
  maximumLines: number;
};

type MetadataLayout = MetadataField & {
  lines: string[];
};

function ellipsize(
  text: string,
  maximumWidth: number,
  measure: (candidate: string) => number,
) {
  const suffix = "...";
  if (measure(`${text}${suffix}`) <= maximumWidth) {
    return `${text}${suffix}`;
  }

  let minimumLength = 0;
  let maximumLength = text.length;
  while (minimumLength < maximumLength) {
    const candidateLength = Math.ceil((minimumLength + maximumLength) / 2);
    const candidate = `${text.slice(0, candidateLength).trimEnd()}${suffix}`;
    if (measure(candidate) <= maximumWidth) {
      minimumLength = candidateLength;
    } else {
      maximumLength = candidateLength - 1;
    }
  }

  return `${text.slice(0, minimumLength).trimEnd()}${suffix}`;
}

function metadataFields(
  plot: ParsedPlot,
  grouping: ExportGrouping,
): MetadataField[] {
  return [
    {
      label: grouping === "sample" ? "Plot" : "Sample",
      value: grouping === "sample" ? plot.groupLabel : plot.sampleName,
      maximumLines: 2,
    },
    {
      label: "Input population",
      value: formatInputPopulations([plot.parentPath]),
      maximumLines: 2,
    },
    {
      label: displayedGateLabel(plot.displayedGateNames),
      value: formatDisplayedGates(plot.displayedGateNames),
      maximumLines: 2,
    },
    {
      label: "Page",
      value: String(plot.pageNumber),
      maximumLines: 1,
    },
  ];
}

export async function exportCollatedPdf(
  report: ParsedReport,
  collatorVersion: string,
  grouping: ExportGrouping = "plot-type",
) {
  const { jsPDF } = await import("jspdf");
  const pages = getExportPages(report, grouping);
  const pdf = new jsPDF({
    orientation: "landscape",
    unit: "pt",
    format: "letter",
  });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 30;
  const headerHeight = 58;
  const footerHeight = 18;
  const gap = 12;
  const availableWidth = pageWidth - margin * 2;
  const availableHeight =
    pageHeight - margin * 2 - headerHeight - footerHeight;
  const cellWidth = (availableWidth - gap * (COLUMNS - 1)) / COLUMNS;
  const cellHeight = (availableHeight - gap * (ROWS - 1)) / ROWS;
  const captionValueWidth =
    cellWidth -
    CARD_PADDING * 2 -
    CAPTION_LABEL_WIDTH -
    CAPTION_COLUMN_GAP;
  let hasPage = false;

  const prepareMetadata = (plot: ParsedPlot) => {
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(CAPTION_FONT_SIZE);

    const fields = metadataFields(plot, grouping).map(
      (field): MetadataLayout => {
        const wrapped = pdf.splitTextToSize(
          field.value,
          captionValueWidth,
        ) as string[];
        const lines =
          wrapped.length > field.maximumLines
            ? [
                ...wrapped.slice(0, field.maximumLines - 1),
                ellipsize(
                  wrapped[field.maximumLines - 1],
                  captionValueWidth,
                  (candidate) => pdf.getTextWidth(candidate),
                ),
              ]
            : wrapped;

        return {
          ...field,
          lines: lines.length > 0 ? lines : [""],
        };
      },
    );
    const captionHeight =
      CARD_PADDING * 2 +
      fields.reduce(
        (height, field) =>
          height + field.lines.length * CAPTION_LINE_HEIGHT,
        0,
      ) +
      (fields.length - 1) * CAPTION_FIELD_GAP;

    return { fields, captionHeight };
  };

  for (const { section, plots, part, partCount } of pages) {
    if (hasPage) {
      pdf.addPage("letter", "landscape");
    }
    hasPage = true;

    const plotLayouts = plots.map((plot) => ({
      plot,
      metadata: prepareMetadata(plot),
    }));
    const rowCaptionHeights = Array.from({ length: ROWS }, (_, row) =>
      Math.max(
        ...plotLayouts
          .slice(row * COLUMNS, (row + 1) * COLUMNS)
          .map((layout) => layout.metadata.captionHeight),
        CARD_PADDING * 2 +
          4 * CAPTION_LINE_HEIGHT +
          3 * CAPTION_FIELD_GAP,
      ),
    );
    const heading = `${grouping === "sample" ? "Sample" : "Plot"}: ${section.label}`;

    pdf.setTextColor(24, 38, 51);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(16);
    const headingWidth = availableWidth * 0.72;
    const measuredHeadingWidth = pdf.getTextWidth(heading);
    if (measuredHeadingWidth > headingWidth) {
      pdf.setFontSize(
        Math.max(10, (16 * headingWidth) / measuredHeadingWidth),
      );
    }
    pdf.text(heading, margin, margin + 14);
    if (grouping === "plot-type") {
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(9);
      pdf.setTextColor(76, 94, 108);
      pdf.text(
        `Input population${section.parentPaths.length === 1 ? "" : "s"}: ${formatInputPopulations(section.parentPaths, 2)}`,
        margin,
        margin + 31,
        { maxWidth: availableWidth * 0.72 },
      );
    }
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(9);
    pdf.setTextColor(76, 94, 108);
    pdf.text(
      `Plots: ${section.plots.length}, page ${part} of ${partCount}`,
      pageWidth - margin,
      margin + 14,
      { align: "right" },
    );

    for (const [index, layout] of plotLayouts.entries()) {
      const { plot, metadata } = layout;
      const column = index % COLUMNS;
      const row = Math.floor(index / COLUMNS);
      const cellX = margin + column * (cellWidth + gap);
      const cellY = margin + headerHeight + row * (cellHeight + gap);
      const captionHeight = rowCaptionHeights[row];
      const dividerY = cellY + cellHeight - captionHeight;
      const imageAvailableWidth = cellWidth - CARD_PADDING * 2;
      const imageAvailableHeight =
        dividerY - cellY - CARD_PADDING * 2;
      const aspectRatio = plot.box.width / plot.box.height;
      let imageWidth = imageAvailableWidth;
      let imageHeight = imageWidth / aspectRatio;

      if (imageHeight > imageAvailableHeight) {
        imageHeight = imageAvailableHeight;
        imageWidth = imageHeight * aspectRatio;
      }

      pdf.setDrawColor(28, 28, 28);
      pdf.setLineWidth(0.5);
      pdf.rect(cellX, cellY, cellWidth, cellHeight);
      pdf.addImage(
        plot.imageUrl,
        "JPEG",
        cellX + (cellWidth - imageWidth) / 2,
        cellY +
          CARD_PADDING +
          (imageAvailableHeight - imageHeight) / 2,
        imageWidth,
        imageHeight,
        undefined,
        "FAST",
      );
      pdf.line(cellX, dividerY, cellX + cellWidth, dividerY);

      const labelX = cellX + CARD_PADDING;
      const valueX =
        labelX + CAPTION_LABEL_WIDTH + CAPTION_COLUMN_GAP;
      let baselineY =
        dividerY + CARD_PADDING + CAPTION_FONT_SIZE;

      for (const [fieldIndex, field] of metadata.fields.entries()) {
        const textColor =
          fieldIndex === 0
            ? ([35, 48, 60] as const)
            : ([76, 94, 108] as const);
        pdf.setTextColor(textColor[0], textColor[1], textColor[2]);
        pdf.setFontSize(CAPTION_FONT_SIZE);
        pdf.setFont("helvetica", "bold");
        pdf.text(field.label, labelX, baselineY);
        pdf.setFont("helvetica", "normal");
        for (const [lineIndex, line] of field.lines.entries()) {
          pdf.text(
            line,
            valueX,
            baselineY + lineIndex * CAPTION_LINE_HEIGHT,
          );
        }
        baselineY +=
          field.lines.length * CAPTION_LINE_HEIGHT +
          CAPTION_FIELD_GAP;
      }
    }

    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(7.5);
    pdf.setTextColor(112, 126, 138);
    pdf.text(report.fileName, margin, pageHeight - 13);
    pdf.text(
      collatorVersion,
      pageWidth - margin,
      pageHeight - 13,
      { align: "right" },
    );
  }

  const baseName = report.fileName.replace(/\.pdf$/i, "");
  const groupingSuffix = grouping === "sample" ? "-by-sample" : "";
  pdf.save(`${baseName}-collated${groupingSuffix}.pdf`);
}
