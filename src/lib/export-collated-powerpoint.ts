import type { ParsedPlot, ParsedReport } from "@/lib/novoexpress-parser";
import {
  getExportPages,
  type ExportGrouping,
} from "@/lib/export-grouping";
import { formatInputPopulations } from "@/lib/report-labels";

const SLIDE_WIDTH = 13.333;
const SLIDE_HEIGHT = 7.5;
const COLUMNS = 3;
const ROWS = 2;

function fitPlot(
  plot: ParsedPlot,
  boxWidth: number,
  boxHeight: number,
) {
  const aspectRatio = plot.box.width / plot.box.height;
  let width = boxWidth;
  let height = width / aspectRatio;

  if (height > boxHeight) {
    height = boxHeight;
    width = height * aspectRatio;
  }

  return { width, height };
}

function titleFontSize(title: string, width: number) {
  const maximumSize = 35;
  const minimumSize = 20;
  const estimatedWidthAtMaximum =
    title.length * maximumSize * 0.56;
  const availableWidthInPoints = width * 72;

  if (estimatedWidthAtMaximum <= availableWidthInPoints) {
    return maximumSize;
  }

  return Math.max(
    minimumSize,
    Math.floor(
      (maximumSize * availableWidthInPoints) /
        estimatedWidthAtMaximum,
    ),
  );
}

export async function exportCollatedPowerpoint(
  report: ParsedReport,
  collatorVersion: string,
  grouping: ExportGrouping = "plot-type",
) {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const presentation = new PptxGenJS();
  const pages = getExportPages(report, grouping);
  const marginX = 0.45;
  const contentTop = 1.22;
  const contentBottom = 7.08;
  const columnGap = 0.18;
  const rowGap = 0.12;
  const contentWidth = SLIDE_WIDTH - marginX * 2;
  const contentHeight = contentBottom - contentTop;
  const cellWidth =
    (contentWidth - columnGap * (COLUMNS - 1)) / COLUMNS;
  const cellHeight = (contentHeight - rowGap * (ROWS - 1)) / ROWS;
  const slideCount = pages.length;
  let slideNumber = 0;

  presentation.layout = "LAYOUT_WIDE";
  presentation.author = "Flow cytometry report collator";
  presentation.company = "";
  presentation.subject =
    grouping === "sample"
      ? "Flow cytometry plots grouped by sample"
      : "Flow cytometry plots grouped by plot type";
  presentation.title = report.metadata.fileName ?? report.fileName;
  presentation.theme = {
    headFontFace: "Arial",
    bodyFontFace: "Arial",
  };

  for (const { section, plots, firstPlot, lastPlot } of pages) {
    const slide = presentation.addSlide();
    const slideTitle =
      `${grouping === "sample" ? "Sample" : "Plot"}: ${section.label}`;
    const slideTitleWidth = SLIDE_WIDTH - marginX * 2;
    slideNumber += 1;
    slide.background = { color: "FFFFFF" };

    slide.addText(
      slideTitle,
      {
        x: marginX,
        y: 0.25,
        w: slideTitleWidth,
        h: 0.52,
        margin: 0,
        fontFace: "Arial",
        fontSize: titleFontSize(slideTitle, slideTitleWidth),
        bold: true,
        color: "111111",
        wrap: false,
      },
    );
    if (grouping === "plot-type") {
      slide.addText(
        `Input population${section.parentPaths.length === 1 ? "" : "s"}: ${formatInputPopulations(section.parentPaths, 2)}`,
        {
          x: marginX,
          y: 0.84,
          w: 9.8,
          h: 0.24,
          margin: 0,
          fontFace: "Arial",
          fontSize: 16,
          color: "555555",
          breakLine: false,
        },
      );
    }
    slide.addText(
      `Plots ${firstPlot}–${lastPlot} of ${section.plots.length}`,
      {
        x: 10.05,
        y: 0.84,
        w: 2.83,
        h: 0.22,
        margin: 0,
        fontFace: "Arial",
        fontSize: 16,
        color: "555555",
        align: "right",
        breakLine: false,
      },
    );

    for (let index = 0; index < plots.length; index += 1) {
      const plot = plots[index];
      const column = index % COLUMNS;
      const row = Math.floor(index / COLUMNS);
      const cellX = marginX + column * (cellWidth + columnGap);
      const cellY = contentTop + row * (cellHeight + rowGap);
      const { width, height } = fitPlot(
        plot,
        cellWidth,
        cellHeight,
      );

      slide.addImage({
        data: plot.imageUrl,
        x: cellX + (cellWidth - width) / 2,
        y: cellY + (cellHeight - height) / 2,
        w: width,
        h: height,
        objectName: `${plot.sampleName} — ${plot.groupLabel}`,
        altText: `${plot.groupLabel} plot for ${plot.sampleName}`,
      });
    }

    slide.addText(report.metadata.fileName ?? report.fileName, {
      x: marginX,
      y: SLIDE_HEIGHT - 0.25,
      w: 6.35,
      h: 0.12,
      margin: 0,
      fontFace: "Arial",
      fontSize: 9,
      color: "777777",
      breakLine: false,
    });
    slide.addText(collatorVersion, {
      x: 6.9,
      y: SLIDE_HEIGHT - 0.25,
      w: 4.55,
      h: 0.12,
      margin: 0,
      fontFace: "Arial",
      fontSize: 8,
      color: "777777",
      align: "right",
      breakLine: false,
    });
    slide.addText(`${slideNumber} / ${slideCount}`, {
      x: 11.65,
      y: SLIDE_HEIGHT - 0.25,
      w: 1.23,
      h: 0.12,
      margin: 0,
      fontFace: "Arial",
      fontSize: 9,
      color: "777777",
      align: "right",
      breakLine: false,
    });
  }

  const baseName = report.fileName.replace(/\.pdf$/i, "");
  const safeBaseName = baseName.replace(/[\\/:*?"<>|]+/g, "-");
  const groupingSuffix = grouping === "sample" ? "-by-sample" : "";
  await presentation.writeFile({
    fileName: `${safeBaseName}-collated${groupingSuffix}.pptx`,
    compression: true,
  });
}
