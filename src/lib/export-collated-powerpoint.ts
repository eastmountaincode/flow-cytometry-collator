import type { ParsedPlot, ParsedReport } from "@/lib/novoexpress-parser";

const SLIDE_WIDTH = 13.333;
const SLIDE_HEIGHT = 7.5;
const PLOTS_PER_SLIDE = 6;
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

export async function exportCollatedPowerpoint(report: ParsedReport) {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const presentation = new PptxGenJS();
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
  const slideCount = report.groups.reduce(
    (count, group) => count + Math.ceil(group.plots.length / PLOTS_PER_SLIDE),
    0,
  );
  let slideNumber = 0;

  presentation.layout = "LAYOUT_WIDE";
  presentation.author = "Flow cytometry report collator";
  presentation.company = "";
  presentation.subject = "Grouped flow cytometry plots";
  presentation.title = report.metadata.fileName ?? report.fileName;
  presentation.theme = {
    headFontFace: "Arial",
    bodyFontFace: "Arial",
  };

  for (const group of report.groups) {
    for (
      let start = 0;
      start < group.plots.length;
      start += PLOTS_PER_SLIDE
    ) {
      const slide = presentation.addSlide();
      const pagePlots = group.plots.slice(start, start + PLOTS_PER_SLIDE);
      const firstSample = start + 1;
      const lastSample = start + pagePlots.length;
      slideNumber += 1;
      slide.background = { color: "FFFFFF" };

      slide.addText(`Plot: ${group.label}`, {
        x: marginX,
        y: 0.25,
        w: SLIDE_WIDTH - marginX * 2,
        h: 0.52,
        margin: 0,
        fontFace: "Arial",
        fontSize: 35,
        bold: true,
        color: "111111",
        breakLine: false,
      });
      slide.addText(
        `Input population: ${
          group.parentPath === "All events"
            ? "All collected events"
            : group.parentPath
        }`,
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
      slide.addText(
        `Samples ${firstSample}–${lastSample} of ${group.plots.length}`,
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

      for (let index = 0; index < pagePlots.length; index += 1) {
        const plot = pagePlots[index];
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
          objectName: `${plot.sampleName} — ${group.label}`,
          altText: `${group.label} plot for ${plot.sampleName}`,
        });
      }

      slide.addText(report.metadata.fileName ?? report.fileName, {
        x: marginX,
        y: SLIDE_HEIGHT - 0.25,
        w: 10.5,
        h: 0.12,
        margin: 0,
        fontFace: "Arial",
        fontSize: 9,
        color: "777777",
        breakLine: false,
      });
      slide.addText(`${slideNumber} / ${slideCount}`, {
        x: 11.55,
        y: SLIDE_HEIGHT - 0.25,
        w: 1.33,
        h: 0.12,
        margin: 0,
        fontFace: "Arial",
        fontSize: 9,
        color: "777777",
        align: "right",
        breakLine: false,
      });
    }
  }

  const baseName = report.fileName.replace(/\.pdf$/i, "");
  const safeBaseName = baseName.replace(/[\\/:*?"<>|]+/g, "-");
  await presentation.writeFile({
    fileName: `${safeBaseName}-collated.pptx`,
    compression: true,
  });
}
