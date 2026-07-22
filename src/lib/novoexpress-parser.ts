import type { PDFPageProxy } from "pdfjs-dist";

const PARSE_SCALE = 1;
const RENDER_SCALE = 2.4;
const MAX_FILE_BYTES = 300 * 1024 * 1024;

type Matrix = [number, number, number, number, number, number];

type PositionedText = {
  text: string;
  x: number;
  y: number;
};

type TextRow = {
  y: number;
  items: PositionedText[];
};

type PlotBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type StatsRow = {
  gateName: string;
  axisX: string;
  axisY: string;
  parentPath: string;
};

type StatsSection = {
  sampleName: string;
  titleY: number;
  rows: StatsRow[];
  hasAxisColumns: boolean;
};

type RawPlot = {
  box: PlotBox;
  documentIndex: number;
  pageNumber: number;
  sampleKey: string;
  statsKey: string;
  sampleName: string;
  title: string;
  parentPath: string;
  imageUrl: string;
  fallbackGroupKey?: string;
  fallbackGroupLabel?: string;
  isCompensation: boolean;
};

export type ParsedPlot = RawPlot & {
  id: string;
  gateName: string;
  axisX: string;
  axisY: string;
  groupKey: string;
  groupLabel: string;
  indexInSample: number;
};

export type PlotGroup = {
  key: string;
  label: string;
  parentPath: string;
  axisX: string;
  axisY: string;
  plots: ParsedPlot[];
};

export type ReportMetadata = {
  fileName: string | null;
  cytometer: string | null;
  runTime: string | null;
  software: string | null;
};

export type ParsedReport = {
  fileName: string;
  reportTitle: string;
  metadata: ReportMetadata;
  pageCount: number;
  sampleNames: string[];
  plots: ParsedPlot[];
  groups: PlotGroup[];
  warnings: string[];
};

export type ParseProgress = {
  currentPage: number;
  pageCount: number;
  percent: number;
  stage: string;
};

type PdfJsModule = typeof import("pdfjs-dist");

function applyMatrix(point: [number, number], matrix: Matrix) {
  const [x, y] = point;
  return [
    x * matrix[0] + y * matrix[2] + matrix[4],
    x * matrix[1] + y * matrix[3] + matrix[5],
  ] as [number, number];
}

function normalizeText(value: string) {
  return value
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s*\/\s*/g, " / ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMetadataText(value: string) {
  return value
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalSample(value: string) {
  return normalizeText(value).toLocaleLowerCase();
}

function canonicalSampleIdentity(value: string) {
  return canonicalSample(value).replace(/^specimen\d+\s*-\s*/, "");
}

function groupTextRows(items: PositionedText[], tolerance = 2): TextRow[] {
  const rows: TextRow[] = [];

  for (const item of items.sort((a, b) => a.y - b.y || a.x - b.x)) {
    let row = rows.find((candidate) => Math.abs(candidate.y - item.y) < tolerance);

    if (!row) {
      row = { y: item.y, items: [] };
      rows.push(row);
    }

    row.items.push(item);
  }

  return rows
    .map((row) => ({
      ...row,
      items: row.items.sort((a, b) => a.x - b.x),
    }))
    .sort((a, b) => a.y - b.y);
}

function rowText(row: TextRow) {
  return normalizeText(row.items.map((item) => item.text).join(" "));
}

function extractReportMetadata(rows: TextRow[]): Partial<ReportMetadata> {
  const metadata: Partial<ReportMetadata> = {};
  const labels = "File Name|Specimen Name|Run Time|Cytometer|Software";

  for (const row of rows.slice(0, 12)) {
    const pattern = new RegExp(
      `(?:^|\\s)(${labels}):\\s*(.*?)(?=\\s+(?:${labels}):|$)`,
      "gi",
    );

    const text = normalizeMetadataText(
      row.items.map((item) => item.text).join(" "),
    );

    for (const match of text.matchAll(pattern)) {
      const label = match[1].toLocaleLowerCase();
      const value = normalizeMetadataText(match[2]);

      if ((label === "file name" || label === "specimen name") && !metadata.fileName) {
        metadata.fileName = value;
      } else if (label === "cytometer") {
        metadata.cytometer = value;
      } else if (label === "run time") {
        metadata.runTime = value;
      } else if (label === "software") {
        metadata.software = value;
      }
    }
  }

  return metadata;
}

function getPositionedText(
  page: PDFPageProxy,
  textContent: Awaited<ReturnType<PDFPageProxy["getTextContent"]>>,
  pdfjs: PdfJsModule,
) {
  const viewport = page.getViewport({ scale: PARSE_SCALE });

  return textContent.items.flatMap((item) => {
    if (!("str" in item) || !item.str.trim()) {
      return [];
    }

    const matrix = pdfjs.Util.transform(
      viewport.transform,
      item.transform,
    ) as Matrix;

    return [
      {
        text: item.str,
        x: matrix[4],
        y: matrix[5],
      },
    ];
  });
}

function extractStatsSections(rows: TextRow[]) {
  const sections: StatsSection[] = [];
  const titleIndexes = rows.flatMap((row, index) =>
    rowText(row).startsWith("Sample Statistics of ") ? [index] : [],
  );

  for (const [titlePosition, index] of titleIndexes.entries()) {
    const title = rowText(rows[index]);
    const sampleName = normalizeText(title.replace("Sample Statistics of ", ""));
    const header = rows
      .slice(index + 1)
      .find((row) => {
        const cells = row.items.map((item) => normalizeText(item.text));
        return (
          cells.includes("Gate") &&
          cells.includes("Count") &&
          cells.includes("% Parent")
        );
      });

    if (!header || header.y - rows[index].y > 40) {
      continue;
    }

    const headerCells = header.items.map((item) => ({
      text: normalizeText(item.text),
      x: item.x,
    }));
    const gateHeader = headerCells.find((cell) => cell.text === "Gate");
    const countHeader = headerCells.find((cell) => cell.text === "Count");
    const parentHeader = headerCells.find((cell) => cell.text === "% Parent");
    const xHeader = headerCells.find((cell) => cell.text === "X");
    const yHeader = headerCells.find((cell) => cell.text === "Y");
    const meanXHeader = headerCells.find((cell) => cell.text === "Mean X");

    if (!gateHeader || !countHeader || !parentHeader) {
      continue;
    }

    const hasAxisColumns = Boolean(xHeader && yHeader && meanXHeader);
    const gateBoundary = countHeader.x - 2;
    const countMaximum = (countHeader.x + parentHeader.x) / 2;
    const xMinimum = xHeader
      ? (parentHeader.x + xHeader.x) / 2
      : Number.POSITIVE_INFINITY;
    const xMaximum = xHeader && yHeader
      ? (xHeader.x + yHeader.x) / 2
      : Number.POSITIVE_INFINITY;
    const yMaximum = yHeader && meanXHeader
      ? (yHeader.x + meanXHeader.x) / 2
      : Number.POSITIVE_INFINITY;
    const nextTitleY = titleIndexes[titlePosition + 1]
      ? rows[titleIndexes[titlePosition + 1]].y
      : Number.POSITIVE_INFINITY;

    const dataRows: StatsRow[] = [];
    const hierarchy: { name: string; x: number }[] = [];
    for (const row of rows) {
      if (
        row.y <= header.y ||
        row.y - header.y > 220 ||
        row.y >= nextTitleY
      ) {
        continue;
      }

      const cellText = (minimum: number, maximum: number) =>
        normalizeText(
          row.items
            .filter((item) => item.x >= minimum && item.x < maximum)
            .map((item) => item.text)
            .join(" "),
        );

      const gateItems = row.items.filter((item) => item.x < gateBoundary);
      const gateName = normalizeText(gateItems.map((item) => item.text).join(" "));
      const gateX = Math.min(...gateItems.map((item) => item.x));
      const countText = cellText(gateBoundary, countMaximum);
      const axisX = cellText(xMinimum, xMaximum);
      const axisY = cellText(xMaximum, yMaximum);

      if (!gateName || !Number.isFinite(gateX) || !/\d/.test(countText)) {
        continue;
      }

      if (gateName === "All") {
        hierarchy.length = 0;
        continue;
      }

      while (
        hierarchy.length > 0 &&
        gateX <= hierarchy[hierarchy.length - 1].x + 1
      ) {
        hierarchy.pop();
      }

      const parentPath = hierarchy.length
        ? hierarchy.map((entry) => entry.name).join(" / ")
        : "All events";
      dataRows.push({ gateName, axisX, axisY, parentPath });
      hierarchy.push({ name: gateName, x: gateX });
    }

    sections.push({
      sampleName,
      titleY: rows[index].y,
      rows: dataRows,
      hasAxisColumns,
    });
  }

  return sections;
}

function extractPlotBoxes(
  page: PDFPageProxy,
  operatorList: Awaited<ReturnType<PDFPageProxy["getOperatorList"]>>,
  pdfjs: PdfJsModule,
) {
  const viewport = page.getViewport({ scale: PARSE_SCALE });
  let currentMatrix: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  const boxes: PlotBox[] = [];

  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operation = operatorList.fnArray[index];
    const args = operatorList.argsArray[index] as unknown[] | null;

    if (operation === pdfjs.OPS.save) {
      stack.push([...currentMatrix] as Matrix);
      continue;
    }

    if (operation === pdfjs.OPS.restore) {
      currentMatrix = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      continue;
    }

    if (operation === pdfjs.OPS.transform && args) {
      currentMatrix = pdfjs.Util.transform(
        currentMatrix,
        args as number[],
      ) as Matrix;
      continue;
    }

    if (
      operation !== pdfjs.OPS.paintImageXObject &&
      operation !== pdfjs.OPS.paintInlineImageXObject
    ) {
      continue;
    }

    const points = (
      [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ] as [number, number][]
    ).map((point) =>
      applyMatrix(applyMatrix(point, currentMatrix), viewport.transform as Matrix),
    );
    const xValues = points.map((point) => point[0]);
    const yValues = points.map((point) => point[1]);
    const box = {
      x: Math.min(...xValues),
      y: Math.min(...yValues),
      width: Math.max(...xValues) - Math.min(...xValues),
      height: Math.max(...yValues) - Math.min(...yValues),
    };

    if (
      box.width >= 90 &&
      box.width <= viewport.width * 0.45 &&
      box.height >= 90 &&
      box.height <= viewport.height * 0.4
    ) {
      boxes.push(box);
    }
  }

  return boxes.sort((a, b) => a.y - b.y || a.x - b.x);
}

function getPlotTitle(box: PlotBox, rows: TextRow[]) {
  const titleRows = rows.filter(
    (row) =>
      row.y >= box.y + 2 &&
      row.y <= box.y + 28 &&
      row.items.some(
        (item) => item.x >= box.x - 4 && item.x <= box.x + box.width + 4,
      ),
  );

  return normalizeText(
    titleRows
      .map((row) =>
        row.items
          .filter(
            (item) => item.x >= box.x - 4 && item.x <= box.x + box.width + 4,
          )
          .map((item) => item.text)
          .join(" "),
      )
      .join(" "),
  );
}

function parsePlotTitle(title: string) {
  const parts = title.split(/\s*\/\s*/).map(normalizeText).filter(Boolean);
  return {
    sampleName: parts[0] ?? "Unknown sample",
    parentPath: parts.length > 1 ? parts.slice(1).join(" / ") : "All events",
  };
}

function cropPlot(
  pageCanvas: HTMLCanvasElement,
  box: PlotBox,
  scale: number,
) {
  const sourceX = Math.max(0, Math.floor((box.x - 2) * scale));
  const sourceY = Math.max(0, Math.floor((box.y - 1) * scale));
  const sourceWidth = Math.min(
    pageCanvas.width - sourceX,
    Math.ceil((box.width + 4) * scale),
  );
  const sourceHeight = Math.min(
    pageCanvas.height - sourceY,
    Math.ceil((box.height + 3) * scale),
  );
  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = sourceWidth;
  cropCanvas.height = sourceHeight;
  const context = cropCanvas.getContext("2d");

  if (!context) {
    throw new Error("Your browser could not create a canvas for the PDF page.");
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, sourceWidth, sourceHeight);
  context.drawImage(
    pageCanvas,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    sourceWidth,
    sourceHeight,
  );

  return cropCanvas.toDataURL("image/jpeg", 0.9);
}

export async function parseNovoExpressReport(
  file: File,
  onProgress: (progress: ParseProgress) => void,
): Promise<ParsedReport> {
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    throw new Error("Choose a PDF report exported from NovoExpress.");
  }

  if (file.size > MAX_FILE_BYTES) {
    throw new Error("This PDF is larger than 300 MB. Split the NovoExpress report first.");
  }

  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
  });
  const documentProxy = await loadingTask.promise;
  const pageCount = documentProxy.numPages;
  const allStats = new Map<string, { sampleName: string; rows: StatsRow[] }>();
  const rawPlots: RawPlot[] = [];
  let reportTitle = file.name.replace(/\.pdf$/i, "");
  let metadata: ReportMetadata = {
    fileName: null,
    cytometer: null,
    runTime: null,
    software: null,
  };
  let documentIndex = 0;
  let inCompensationSection = false;
  let lastSampleBase = "";
  const sampleOccurrences = new Map<string, number>();
  const sampleDisplayNames = new Map<string, string>();

  const sampleIdentity = (sampleName: string) => {
    const statsKey = canonicalSampleIdentity(sampleName);
    if (statsKey !== lastSampleBase) {
      sampleOccurrences.set(statsKey, (sampleOccurrences.get(statsKey) ?? 0) + 1);
      lastSampleBase = statsKey;
    }
    const occurrence = sampleOccurrences.get(statsKey) ?? 1;
    const sampleKey = `${statsKey}::${occurrence}`;
    if (!sampleDisplayNames.has(sampleKey)) {
      sampleDisplayNames.set(
        sampleKey,
        occurrence > 1 ? `${sampleName} (${occurrence})` : sampleName,
      );
    }
    return {
      statsKey,
      sampleKey,
      sampleName: sampleDisplayNames.get(sampleKey) ?? sampleName,
    };
  };

  onProgress({
    currentPage: 0,
    pageCount,
    percent: 2,
    stage: "Opening report",
  });

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await documentProxy.getPage(pageNumber);
    const [textContent, operatorList] = await Promise.all([
      page.getTextContent(),
      page.getOperatorList(),
    ]);
    const positionedText = getPositionedText(page, textContent, pdfjs);
    const rows = groupTextRows(positionedText);
    const pageMetadata = extractReportMetadata(rows);
    metadata = {
      fileName: metadata.fileName ?? pageMetadata.fileName ?? null,
      cytometer: metadata.cytometer ?? pageMetadata.cytometer ?? null,
      runTime: metadata.runTime ?? pageMetadata.runTime ?? null,
      software: metadata.software ?? pageMetadata.software ?? null,
    };
    if (rows.some((row) => /^Specimen\d+\b/.test(rowText(row)))) {
      inCompensationSection = false;
    }
    if (rows.some((row) => rowText(row) === "Compensation Specimen")) {
      inCompensationSection = true;
    }
    const firstReportRow = rows.find((row) => rowText(row).startsWith("Report of "));
    if (firstReportRow) {
      reportTitle = rowText(firstReportRow);
    }

    const pageStats = extractStatsSections(rows);
    for (const section of pageStats) {
      allStats.set(canonicalSampleIdentity(section.sampleName), {
        sampleName: section.sampleName,
        rows: section.rows,
      });
    }

    const boxes = extractPlotBoxes(page, operatorList, pdfjs);
    if (boxes.length > 0) {
      const renderViewport = page.getViewport({ scale: RENDER_SCALE });
      const pageCanvas = document.createElement("canvas");
      pageCanvas.width = Math.ceil(renderViewport.width);
      pageCanvas.height = Math.ceil(renderViewport.height);
      await page.render({ canvas: pageCanvas, viewport: renderViewport }).promise;

      const assignedBoxes = new Set<PlotBox>();
      let previousSectionY = Number.NEGATIVE_INFINITY;

      for (const section of pageStats.sort((a, b) => a.titleY - b.titleY)) {
        const sectionBoxes = boxes.filter(
          (box) =>
            !assignedBoxes.has(box) &&
            box.y > previousSectionY &&
            box.y + box.height <= section.titleY + 8,
        );

        for (const [plotIndex, box] of sectionBoxes.entries()) {
          assignedBoxes.add(box);
          const title = getPlotTitle(box, rows);
          const titleParts = title ? parsePlotTitle(title) : null;
          const matchedStats =
            section.rows.length === sectionBoxes.length
              ? section.rows[plotIndex]
              : undefined;
          const parentPath = titleParts?.parentPath && titleParts.parentPath !== "All events"
            ? titleParts.parentPath
            : matchedStats?.parentPath ?? "Rasterized NovoExpress layout";
          const identity = sampleIdentity(section.sampleName);
          const needsLayoutFallback = !section.hasAxisColumns;

          rawPlots.push({
            box,
            documentIndex,
            pageNumber,
            ...identity,
            title: title || section.sampleName,
            parentPath,
            imageUrl: cropPlot(pageCanvas, box, RENDER_SCALE),
            isCompensation: inCompensationSection,
            ...(!needsLayoutFallback
              ? {}
              : {
                  fallbackGroupKey: `raster-layout-${sectionBoxes.length}-${plotIndex}`,
                  fallbackGroupLabel: `Plot ${plotIndex + 1} of ${sectionBoxes.length} (rasterized axes)`,
                }),
          });
          documentIndex += 1;
        }

        previousSectionY = section.titleY;
      }

      for (const box of boxes.filter((candidate) => !assignedBoxes.has(candidate))) {
        const title = getPlotTitle(box, rows);
        if (title) {
          const { sampleName, parentPath } = parsePlotTitle(title);
          const identity = sampleIdentity(sampleName);
          rawPlots.push({
            box,
            documentIndex,
            pageNumber,
            ...identity,
            title,
            parentPath,
            imageUrl: cropPlot(pageCanvas, box, RENDER_SCALE),
            isCompensation: inCompensationSection,
          });
          documentIndex += 1;
        }
      }

      pageCanvas.width = 1;
      pageCanvas.height = 1;
    }

    page.cleanup();
    onProgress({
      currentPage: pageNumber,
      pageCount,
      percent: Math.round(5 + (pageNumber / pageCount) * 87),
      stage: `Reading page ${pageNumber} of ${pageCount}`,
    });
  }

  if (rawPlots.length === 0) {
    throw new Error(
      "No NovoExpress plot images were detected. This may be a different report layout.",
    );
  }

  const warnings: string[] = [];
  const plotsBySample = new Map<string, RawPlot[]>();
  for (const plot of rawPlots) {
    plotsBySample.set(plot.sampleKey, [
      ...(plotsBySample.get(plot.sampleKey) ?? []),
      plot,
    ]);
  }

  const parsedPlots: ParsedPlot[] = [];
  let usedLayoutFallback = false;
  const unmatchedStatsSamples: string[] = [];
  for (const [, samplePlots] of plotsBySample) {
    const orderedPlots = samplePlots.sort(
      (a, b) => a.documentIndex - b.documentIndex,
    );
    const sampleStats = allStats.get(orderedPlots[0].statsKey);

    const statsMismatch = sampleStats?.rows.length !== orderedPlots.length;
    const usesRasterFallback = orderedPlots.some(
      (plot) => plot.fallbackGroupKey || plot.isCompensation,
    ) || statsMismatch;
    usedLayoutFallback ||= usesRasterFallback;

    if (!sampleStats) {
      unmatchedStatsSamples.push(orderedPlots[0].sampleName);
    } else if (!usesRasterFallback && statsMismatch) {
      warnings.push(
        `${orderedPlots[0].sampleName} has ${orderedPlots.length} plots but ${sampleStats.rows.length} statistics rows. Review its grouping.`,
      );
    }

    orderedPlots.forEach((plot, indexInSample) => {
      const compensationKey = plot.isCompensation
        ? `compensation::${plot.sampleKey}::${indexInSample}`
        : undefined;
      const layoutFallbackKey = compensationKey ?? plot.fallbackGroupKey ?? (
        statsMismatch ? `raster-layout-${orderedPlots.length}-${indexInSample}` : undefined
      );
      const statsRow = layoutFallbackKey
        ? undefined
        : sampleStats?.rows[indexInSample];
      const axisX = statsRow?.axisX || "Rasterized x-axis";
      const axisY = statsRow?.axisY || "Rasterized y-axis";
      const gateName = statsRow?.gateName ?? `Plot position ${indexInSample + 1}`;
      const groupLabel = plot.isCompensation
        ? `${plot.sampleName}, plot ${indexInSample + 1}`
        : plot.fallbackGroupLabel ?? (
        statsRow ? `${axisX} vs ${axisY}` : `Plot ${indexInSample + 1}`
      );
      const groupKey = layoutFallbackKey ?? [plot.parentPath, axisX, axisY]
        .map((value) => normalizeText(value).toLocaleLowerCase())
        .join("::");

      parsedPlots.push({
        ...plot,
        id: `${plot.pageNumber}-${plot.documentIndex}`,
        axisX,
        axisY,
        gateName,
        groupKey,
        groupLabel,
        indexInSample,
      });
    });
  }

  const groupMap = new Map<string, PlotGroup>();
  for (const plot of parsedPlots.sort(
    (a, b) => a.documentIndex - b.documentIndex,
  )) {
    const group = groupMap.get(plot.groupKey) ?? {
      key: plot.groupKey,
      label: plot.groupLabel,
      parentPath: plot.parentPath,
      axisX: plot.axisX,
      axisY: plot.axisY,
      plots: [],
    };
    group.plots.push(plot);
    groupMap.set(plot.groupKey, group);
  }

  const groups = [...groupMap.values()];
  if (unmatchedStatsSamples.length > 0) {
    const examples = unmatchedStatsSamples.slice(0, 3).join(", ");
    warnings.push(
      `${unmatchedStatsSamples.length} sample layout${unmatchedStatsSamples.length === 1 ? "" : "s"} had no matching statistics table${examples ? ` (for example: ${examples})` : ""}. Those plots use positional grouping.`,
    );
  }
  if (usedLayoutFallback) {
    warnings.unshift(
      "Some axis labels are rasterized or do not map one-to-one to statistics rows. Matching uses plot position within each sample layout; compensation controls stay separate. Review groups before export.",
    );
  }
  const pathsByAxes = new Map<string, Set<string>>();
  for (const group of groups) {
    const axisKey = `${group.axisX.toLocaleLowerCase()}::${group.axisY.toLocaleLowerCase()}`;
    const paths = pathsByAxes.get(axisKey) ?? new Set<string>();
    paths.add(group.parentPath);
    pathsByAxes.set(axisKey, paths);
  }
  for (const [axisKey, paths] of pathsByAxes) {
    if (
      paths.size > 1 &&
      !axisKey.includes("unknown") &&
      !axisKey.includes("rasterized")
    ) {
      const [axisX, axisY] = axisKey.split("::");
      warnings.push(
        `${axisX} vs ${axisY} appears under ${paths.size} parent populations, so those plots remain in separate groups.`,
      );
    }
  }

  const sampleNames = [...plotsBySample.values()]
    .map((plots) => plots[0].sampleName)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  onProgress({
    currentPage: pageCount,
    pageCount,
    percent: 100,
    stage: "Report ready",
  });

  await loadingTask.destroy();

  return {
    fileName: file.name,
    reportTitle,
    metadata: {
      ...metadata,
      fileName:
        metadata.fileName ??
        reportTitle.replace(/^Report of\s+/i, "") ??
        file.name.replace(/\.pdf$/i, ""),
    },
    pageCount,
    sampleNames,
    plots: parsedPlots,
    groups,
    warnings,
  };
}
