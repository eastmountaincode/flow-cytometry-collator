import type { PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { AXIS_LABEL_TEMPLATE_SETS } from "./axis-label-templates.generated";
import { MAX_REPORT_BYTES } from "./report-limits";

const PARSE_SCALE = 1;
const RENDER_SCALE = 2.4;
const AXIS_FINGERPRINT_WIDTH = 64;
const AXIS_FINGERPRINT_HEIGHT = 16;
const AXIS_LABEL_MATCH_MARGIN = 0.03;
// Across the current 2,842-axis fixture audit, template matches stay below
// 0.024 distance and the nearest wrong label stays above 0.127.
const AXIS_FINGERPRINT_THRESHOLD = 0.075;
const FINGERPRINT_FIXED_POINT = 65_536;
const FINGERPRINT_FIXED_POINT_SQUARED =
  FINGERPRINT_FIXED_POINT * FINGERPRINT_FIXED_POINT;

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

type PdfImageData = {
  width: number;
  height: number;
  kind?: number;
  data?: Uint8Array | Uint8ClampedArray;
  bitmap?: ImageBitmap;
};

type DetectedPlot = {
  box: PlotBox;
  imageObjectId?: string;
  inlineImage?: PdfImageData;
};

type AxisFingerprint = {
  x: Uint8Array;
  y: Uint8Array;
};

type PixelBuffer = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
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

type PlotStructure = {
  inputPopulation: string;
  gateNames: string[];
};

type PendingPlot = {
  box: PlotBox;
  documentIndex: number;
  pageNumber: number;
  title: string;
  imageUrl: string;
  structure: PlotStructure | null;
  isCompensation: boolean;
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
  nativeOutputGateNames: string[] | null;
  fallbackGateName?: string;
  isCompensation: boolean;
};

export type ParsedPlot = RawPlot & {
  id: string;
  displayedGateNames: string[];
  axisX: string;
  axisY: string;
  groupKey: string;
  groupLabel: string;
  indexInSample: number;
};

export type PlotGroup = {
  key: string;
  label: string;
  parentPaths: string[];
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

export type ReportFile = {
  name: string;
  type: string;
  size: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

export type ParserCanvasFactory = (
  width: number,
  height: number,
) => HTMLCanvasElement;

export type ParserOptions = {
  createCanvas?: ParserCanvasFactory;
};

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

function createBrowserCanvas(width: number, height: number) {
  if (typeof document === "undefined") {
    throw new Error("No PDF canvas implementation is available.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

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
    const summaryXHeader = headerCells.find(
      (cell) => cell.text === "Mean X" || cell.text === "Median X",
    );

    if (!gateHeader || !countHeader || !parentHeader) {
      continue;
    }

    const hasAxisColumns = Boolean(xHeader && yHeader && summaryXHeader);
    const gateBoundary = countHeader.x - 2;
    const countMaximum = (countHeader.x + parentHeader.x) / 2;
    const xMinimum = xHeader
      ? (parentHeader.x + xHeader.x) / 2
      : Number.POSITIVE_INFINITY;
    const xMaximum = xHeader && yHeader
      ? (xHeader.x + yHeader.x) / 2
      : Number.POSITIVE_INFINITY;
    const yMaximum = yHeader && summaryXHeader
      ? (yHeader.x + summaryXHeader.x) / 2
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
  const detectedPlots: DetectedPlot[] = [];

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
      const imageArgument = args?.[0];
      detectedPlots.push({
        box,
        imageObjectId:
          operation === pdfjs.OPS.paintImageXObject &&
          typeof imageArgument === "string"
            ? imageArgument
            : undefined,
        inlineImage:
          operation === pdfjs.OPS.paintInlineImageXObject &&
          typeof imageArgument === "object" &&
          imageArgument !== null
            ? (imageArgument as PdfImageData)
            : undefined,
      });
    }
  }

  return detectedPlots.sort(
    (a, b) =>
      a.box.y - b.box.y ||
      a.box.x - b.box.x,
  );
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

function canonicalGate(value: string) {
  return normalizeText(value)
    .replace(/\s+/g, "")
    .toLocaleLowerCase();
}

function horizontalOverlap(first: PlotBox, second: PlotBox) {
  const left = Math.max(first.x, second.x);
  const right = Math.min(first.x + first.width, second.x + second.width);
  return Math.max(0, right - left);
}

function extractPlotStructure(
  box: PlotBox,
  pageBoxes: PlotBox[],
  rows: TextRow[],
): PlotStructure | null {
  const nextBoxInColumn = pageBoxes
    .filter(
      (candidate) =>
        candidate !== box &&
        candidate.y > box.y + box.height &&
        horizontalOverlap(box, candidate) >= Math.min(box.width, candidate.width) * 0.5,
    )
    .sort((a, b) => a.y - b.y)[0];
  const nextStatsTitle = rows.find(
    (row) =>
      row.y > box.y + box.height &&
      rowText(row).startsWith("Sample Statistics of "),
  );
  const maximumY = Math.min(
    nextBoxInColumn?.y ? nextBoxInColumn.y - 4 : Number.POSITIVE_INFINITY,
    nextStatsTitle?.y ? nextStatsTitle.y - 4 : Number.POSITIVE_INFINITY,
    box.y + box.height + 230,
  );
  const minimumX = box.x - 5;
  const maximumX = box.x + box.width + 5;
  const itemsInBand = (row: TextRow) =>
    row.items.filter((item) => item.x >= minimumX && item.x <= maximumX);

  const header = rows.find((row) => {
    if (row.y <= box.y + box.height || row.y >= maximumY) {
      return false;
    }
    const cells = itemsInBand(row).map((item) => normalizeText(item.text));
    return cells.includes("Gate") && cells.includes("Count");
  });

  if (!header) {
    return null;
  }

  const headerItems = itemsInBand(header);
  const gateHeader = headerItems.find(
    (item) => normalizeText(item.text) === "Gate",
  );
  const countHeader = headerItems.find(
    (item) => normalizeText(item.text) === "Count",
  );

  if (!gateHeader || !countHeader) {
    return null;
  }

  const headerText = normalizeText(
    headerItems
      .filter((item) => item.x >= countHeader.x + 15)
      .map((item) => item.text)
      .join(" "),
  );
  const percentColumns = [...headerText.matchAll(/%\s+(.+?)(?=\s+%|$)/g)]
    .map((match) => normalizeText(match[1]))
    .filter(Boolean);
  const firstPercentColumn = percentColumns[0] ?? "All";
  const inputPopulation =
    canonicalGate(firstPercentColumn) === "all"
      ? "All events"
      : firstPercentColumn;
  const gateBoundary = (gateHeader.x + countHeader.x) / 2;
  const gateNames: string[] = [];

  for (const row of rows) {
    if (row.y <= header.y || row.y >= maximumY) {
      continue;
    }

    const bandItems = itemsInBand(row);
    const gateName = normalizeText(
      bandItems
        .filter(
          (item) =>
            item.x >= gateHeader.x - 1 &&
            item.x < gateBoundary &&
            !/^\d+(?:\.\d+)?%$/.test(normalizeText(item.text)),
        )
        .map((item) => item.text)
        .join(" "),
    );
    const countText = normalizeText(
      bandItems
        .filter((item) => item.x >= gateBoundary)
        .map((item) => item.text)
        .join(" "),
    );

    if (
      gateName &&
      gateName.length > 1 &&
      !/^%/.test(gateName) &&
      (/\d/.test(countText) || !/\d/.test(gateName)) &&
      !gateNames.some((candidate) => canonicalGate(candidate) === canonicalGate(gateName))
    ) {
      gateNames.push(gateName);
    }
  }

  return gateNames.length > 0
    ? {
        inputPopulation,
        gateNames,
      }
    : null;
}

function matchStatsGateName(gateName: string, rows: StatsRow[]) {
  const key = canonicalGate(gateName);
  const exact = rows.find((row) => canonicalGate(row.gateName) === key);
  if (exact) {
    return exact.gateName;
  }

  const prefixMatches = rows.filter((row) => {
    const candidate = canonicalGate(row.gateName);
    return candidate.startsWith(key) || key.startsWith(candidate);
  });
  return prefixMatches.length === 1 ? prefixMatches[0].gateName : gateName;
}

function normalizePlotStructure(
  structure: PlotStructure,
  statsRows: StatsRow[],
) {
  const inputPopulation =
    structure.inputPopulation === "All events"
      ? "All events"
      : matchStatsGateName(structure.inputPopulation, statsRows);
  const gateNames = structure.gateNames.map((gateName) =>
    gateName === "All" ? "All" : matchStatsGateName(gateName, statsRows),
  );
  return {
    inputPopulation,
    gateNames: [...new Set(gateNames)],
  };
}

function getInputPopulationPath(inputPopulation: string, rows: StatsRow[]) {
  if (inputPopulation === "All events" || canonicalGate(inputPopulation) === "all") {
    return "All events";
  }

  const inputRow = rows.find(
    (row) => canonicalGate(row.gateName) === canonicalGate(inputPopulation),
  );
  if (!inputRow || inputRow.parentPath === "All events") {
    return inputPopulation;
  }
  return `${inputRow.parentPath} / ${inputRow.gateName}`;
}

function getOutputGates(structure: PlotStructure) {
  const inputKey = canonicalGate(structure.inputPopulation);
  return structure.gateNames.filter((gateName) => {
    const key = canonicalGate(gateName);
    return key !== "all" && key !== inputKey;
  });
}

function describePlotStructure(structure: PlotStructure) {
  const outputGates = getOutputGates(structure);
  if (outputGates.length === 0) {
    return `${structure.inputPopulation}, no displayed gate`;
  }

  const quadrantPrefixes = new Set(
    outputGates
      .map((gateName) => gateName.match(/^(Q\d+)-\d+$/i)?.[1])
      .filter((value): value is string => Boolean(value)),
  );
  if (
    quadrantPrefixes.size === 1 &&
    outputGates.every((gateName) => /^(Q\d+)-\d+$/i.test(gateName))
  ) {
    return `${[...quadrantPrefixes][0]} quadrants`;
  }

  return outputGates.length === 1
    ? `${outputGates[0]} gate`
    : `${outputGates.join(", ")} gates`;
}

function parsePlotTitle(title: string) {
  const parts = title.split(/\s*\/\s*/).map(normalizeText).filter(Boolean);
  return {
    sampleName: parts[0] ?? "Unknown sample",
    parentPath: parts.length > 1 ? parts.slice(1).join(" / ") : "All events",
  };
}

function makeAxisBandFingerprint(
  cropCanvas: HTMLCanvasElement,
  axis: "x" | "y",
) {
  const context = cropCanvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return null;
  }

  // NovoExpress raster plots place the X caption in the bottom strip and the
  // rotated Y caption in the left strip of the embedded plot image.
  const horizontal = axis === "x";
  const bandX = Math.floor(
    cropCanvas.width * (horizontal ? 0.02 : 0.01),
  );
  const bandY = Math.floor(
    cropCanvas.height * (horizontal ? 0.895 : 0.06),
  );
  const bandWidth = Math.max(
    1,
    Math.ceil(cropCanvas.width * (horizontal ? 0.96 : 0.09)),
  );
  const bandHeight = Math.max(
    1,
    Math.ceil(cropCanvas.height * (horizontal ? 0.1 : 0.8)),
  );
  const sourceWidth = Math.min(bandWidth, cropCanvas.width - bandX);
  const sourceHeight = Math.min(bandHeight, cropCanvas.height - bandY);
  const sourcePixels = context.getImageData(
    bandX,
    bandY,
    sourceWidth,
    sourceHeight,
  );
  const pixels: PixelBuffer = horizontal
    ? sourcePixels
    : (() => {
        const rotated: PixelBuffer = {
          width: sourceHeight,
          height: sourceWidth,
          data: new Uint8ClampedArray(sourceWidth * sourceHeight * 4),
        };
        for (let y = 0; y < sourceHeight; y += 1) {
          for (let x = 0; x < sourceWidth; x += 1) {
            const sourceOffset = (y * sourceWidth + x) * 4;
            const targetX = sourceHeight - y - 1;
            const targetY = x;
            const targetOffset = (targetY * rotated.width + targetX) * 4;
            rotated.data[targetOffset] = sourcePixels.data[sourceOffset];
            rotated.data[targetOffset + 1] =
              sourcePixels.data[sourceOffset + 1];
            rotated.data[targetOffset + 2] =
              sourcePixels.data[sourceOffset + 2];
            rotated.data[targetOffset + 3] =
              sourcePixels.data[sourceOffset + 3];
          }
        }
        return rotated;
      })();

  const luminanceAt = (x: number, y: number) => {
    const offset = (y * pixels.width + x) * 4;
    return (
      (pixels.data[offset] * 77 +
        pixels.data[offset + 1] * 150 +
        pixels.data[offset + 2] * 29) >>
      8
    );
  };
  const isInk = (x: number, y: number) => luminanceAt(x, y) < 190;

  const findInkBounds = (maximumAllowedX = pixels.width - 1) => {
    let minimumX = pixels.width;
    let minimumY = pixels.height;
    let maximumX = -1;
    let maximumY = -1;
    let inkPixels = 0;

    for (let y = 0; y < pixels.height; y += 1) {
      for (
        let x = 0;
        x < pixels.width && x <= maximumAllowedX;
        x += 1
      ) {
        if (!isInk(x, y)) {
          continue;
        }

        inkPixels += 1;
        minimumX = Math.min(minimumX, x);
        minimumY = Math.min(minimumY, y);
        maximumX = Math.max(maximumX, x);
        maximumY = Math.max(maximumY, y);
      }
    }

    return inkPixels < 8 || maximumX < minimumX || maximumY < minimumY
      ? null
      : { minimumX, minimumY, maximumX, maximumY };
  };

  let bounds = findInkBounds();
  if (!bounds) {
    return null;
  }

  const columnRuns: Array<{ start: number; end: number }> = [];
  let runStart: number | null = null;
  for (let x = bounds.minimumX; x <= bounds.maximumX; x += 1) {
    let hasInk = false;
    for (let y = bounds.minimumY; y <= bounds.maximumY; y += 1) {
      if (isInk(x, y)) {
        hasInk = true;
        break;
      }
    }

    if (hasInk && runStart === null) {
      runStart = x;
    }
    if (
      runStart !== null &&
      (!hasInk || x === bounds.maximumX)
    ) {
      columnRuns.push({
        start: runStart,
        end: hasInk && x === bounds.maximumX ? x : x - 1,
      });
      runStart = null;
    }
  }

  const axisLabelHeight = bounds.maximumY - bounds.minimumY + 1;
  if (
    axisLabelHeight >= cropCanvas.height * 0.056 &&
    columnRuns.length >= 6
  ) {
    const precedingRunIndex = columnRuns.length - 6;
    const precedingRun = columnRuns[precedingRunIndex];
    const suffixStart = columnRuns[precedingRunIndex + 1];
    const suffixGap = suffixStart.start - precedingRun.end - 1;
    if (suffixGap >= cropCanvas.width * 0.019) {
      bounds = findInkBounds(precedingRun.end) ?? bounds;
    }
  }

  const fingerprint = new Uint8Array(
    AXIS_FINGERPRINT_WIDTH * AXIS_FINGERPRINT_HEIGHT,
  );
  const fingerprintSourceWidth = bounds.maximumX - bounds.minimumX + 1;
  const fingerprintSourceHeight = bounds.maximumY - bounds.minimumY + 1;

  for (let outputY = 0; outputY < AXIS_FINGERPRINT_HEIGHT; outputY += 1) {
    const rawSourceY = Math.floor(
      (
        ((outputY * 2 + 1) *
          fingerprintSourceHeight *
          FINGERPRINT_FIXED_POINT) /
        (AXIS_FINGERPRINT_HEIGHT * 2)
      ) - FINGERPRINT_FIXED_POINT / 2,
    );
    const sourceYFixed = Math.max(
      0,
      Math.min(
        (fingerprintSourceHeight - 1) * FINGERPRINT_FIXED_POINT,
        rawSourceY,
      ),
    );
    const sourceY = Math.floor(sourceYFixed / FINGERPRINT_FIXED_POINT);
    const nextSourceY = Math.min(
      fingerprintSourceHeight - 1,
      sourceY + 1,
    );
    const yWeight = sourceYFixed - sourceY * FINGERPRINT_FIXED_POINT;

    for (let outputX = 0; outputX < AXIS_FINGERPRINT_WIDTH; outputX += 1) {
      const rawSourceX = Math.floor(
        (
          ((outputX * 2 + 1) *
            fingerprintSourceWidth *
            FINGERPRINT_FIXED_POINT) /
          (AXIS_FINGERPRINT_WIDTH * 2)
        ) - FINGERPRINT_FIXED_POINT / 2,
      );
      const sourceXFixed = Math.max(
        0,
        Math.min(
          (fingerprintSourceWidth - 1) * FINGERPRINT_FIXED_POINT,
          rawSourceX,
        ),
      );
      const sourceX = Math.floor(sourceXFixed / FINGERPRINT_FIXED_POINT);
      const nextSourceX = Math.min(
        fingerprintSourceWidth - 1,
        sourceX + 1,
      );
      const xWeight = sourceXFixed - sourceX * FINGERPRINT_FIXED_POINT;
      const top =
        luminanceAt(bounds.minimumX + sourceX, bounds.minimumY + sourceY) *
          (FINGERPRINT_FIXED_POINT - xWeight) +
        luminanceAt(
          bounds.minimumX + nextSourceX,
          bounds.minimumY + sourceY,
        ) *
          xWeight;
      const bottom =
        luminanceAt(
          bounds.minimumX + sourceX,
          bounds.minimumY + nextSourceY,
        ) *
          (FINGERPRINT_FIXED_POINT - xWeight) +
        luminanceAt(
          bounds.minimumX + nextSourceX,
          bounds.minimumY + nextSourceY,
        ) *
          xWeight;
      const luminance = Math.floor(
        (
          top * (FINGERPRINT_FIXED_POINT - yWeight) +
          bottom * yWeight +
          FINGERPRINT_FIXED_POINT_SQUARED / 2
        ) / FINGERPRINT_FIXED_POINT_SQUARED,
      );
      fingerprint[
        outputY * AXIS_FINGERPRINT_WIDTH + outputX
      ] = 255 - luminance;
    }
  }

  return fingerprint;
}

function axisFingerprintDistance(first: Uint8Array, second: Uint8Array) {
  if (first.length !== second.length || first.length === 0) {
    return Number.POSITIVE_INFINITY;
  }

  let difference = 0;
  for (let index = 0; index < first.length; index += 1) {
    difference += Math.abs(first[index] - second[index]);
  }
  return difference / (first.length * 255);
}

function compareAxisFingerprints(
  first: AxisFingerprint,
  second: AxisFingerprint,
) {
  const x = axisFingerprintDistance(first.x, second.x);
  const y = axisFingerprintDistance(first.y, second.y);
  return {
    x,
    y,
    matches:
      x <= AXIS_FINGERPRINT_THRESHOLD &&
      y <= AXIS_FINGERPRINT_THRESHOLD,
  };
}

type DecodedAxisLabelTemplateSet = {
  label: string;
  fingerprints: Uint8Array[];
};

let decodedAxisLabelTemplateSets:
  | DecodedAxisLabelTemplateSet[]
  | null = null;

function getDecodedAxisLabelTemplateSets() {
  if (decodedAxisLabelTemplateSets) {
    return decodedAxisLabelTemplateSets;
  }

  decodedAxisLabelTemplateSets = AXIS_LABEL_TEMPLATE_SETS.map((templateSet) => ({
    label: templateSet.label,
    fingerprints: templateSet.fingerprints.map((encoded) => {
      const binary = atob(encoded);
      if (
        binary.length !==
        (AXIS_FINGERPRINT_WIDTH * AXIS_FINGERPRINT_HEIGHT) / 2
      ) {
        throw new Error(
          `Axis template "${templateSet.label}" has an invalid fingerprint.`,
        );
      }
      const fingerprint = new Uint8Array(binary.length * 2);
      for (let index = 0; index < binary.length; index += 1) {
        const packed = binary.charCodeAt(index);
        fingerprint[index * 2] = (packed >> 4) * 17;
        fingerprint[index * 2 + 1] = (packed & 0x0f) * 17;
      }
      return fingerprint;
    }),
  }));
  return decodedAxisLabelTemplateSets;
}

function identifyAxisLabel(
  fingerprints: AxisFingerprint[],
  axis: "x" | "y",
) {
  if (fingerprints.length === 0) {
    return null;
  }

  const scores = getDecodedAxisLabelTemplateSets()
    .map((templateSet) => ({
      label: templateSet.label,
      // Every representative in the group must be explained by the same
      // printed label. This prevents one unusually close plot from naming an
      // otherwise unknown group.
      distance: Math.max(
        ...fingerprints.map((fingerprint) =>
          Math.min(
            ...templateSet.fingerprints.map((template) =>
              axisFingerprintDistance(fingerprint[axis], template),
            ),
          ),
        ),
      ),
    }))
    .sort((first, second) => first.distance - second.distance);
  const best = scores[0];
  const nextBest = scores[1];
  if (
    !best ||
    best.distance > AXIS_FINGERPRINT_THRESHOLD ||
    (
      nextBest &&
      nextBest.distance - best.distance < AXIS_LABEL_MATCH_MARGIN
    )
  ) {
    return null;
  }

  return best;
}

async function getPlotImageData(
  page: PDFPageProxy,
  detectedPlot: DetectedPlot,
) {
  if (detectedPlot.inlineImage) {
    return detectedPlot.inlineImage;
  }
  if (!detectedPlot.imageObjectId) {
    return null;
  }

  if (page.objs.has(detectedPlot.imageObjectId)) {
    return page.objs.get(detectedPlot.imageObjectId) as PdfImageData;
  }

  return new Promise<PdfImageData | null>((resolve) => {
    page.objs.get(
      detectedPlot.imageObjectId as string,
      (imageData: PdfImageData | null) => resolve(imageData),
    );
  });
}

function imageDataCanvas(
  image: PdfImageData,
  pdfjs: PdfJsModule,
  createCanvas: ParserCanvasFactory,
) {
  if (!image.width || !image.height) {
    return null;
  }

  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }

  if (image.bitmap) {
    context.drawImage(image.bitmap, 0, 0, image.width, image.height);
    return canvas;
  }
  if (!image.data) {
    return null;
  }

  const canvasPixels = context.createImageData(image.width, image.height);
  if (image.kind === pdfjs.ImageKind.RGBA_32BPP) {
    canvasPixels.data.set(image.data);
  } else if (image.kind === pdfjs.ImageKind.RGB_24BPP) {
    for (
      let sourceOffset = 0, targetOffset = 0;
      sourceOffset < image.data.length;
      sourceOffset += 3, targetOffset += 4
    ) {
      canvasPixels.data[targetOffset] = image.data[sourceOffset];
      canvasPixels.data[targetOffset + 1] = image.data[sourceOffset + 1];
      canvasPixels.data[targetOffset + 2] = image.data[sourceOffset + 2];
      canvasPixels.data[targetOffset + 3] = 255;
    }
  } else {
    return null;
  }

  context.putImageData(canvasPixels, 0, 0);
  return canvas;
}

function cropPlot(
  pageCanvas: HTMLCanvasElement,
  box: PlotBox,
  scale: number,
  createCanvas: ParserCanvasFactory,
  axisSourceCanvas?: HTMLCanvasElement | null,
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
  const cropCanvas = createCanvas(sourceWidth, sourceHeight);
  const context = cropCanvas.getContext("2d");

  if (!context) {
    throw new Error("A canvas could not be created for the PDF page.");
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

  const fingerprintCanvas = axisSourceCanvas ?? cropCanvas;
  let xFingerprint = makeAxisBandFingerprint(fingerprintCanvas, "x");
  let yFingerprint = makeAxisBandFingerprint(fingerprintCanvas, "y");
  if (axisSourceCanvas && (!xFingerprint || !yFingerprint)) {
    xFingerprint = makeAxisBandFingerprint(cropCanvas, "x");
    yFingerprint = makeAxisBandFingerprint(cropCanvas, "y");
  }
  const result = {
    imageUrl: cropCanvas.toDataURL("image/jpeg", 0.9),
    axisFingerprint:
      xFingerprint && yFingerprint
        ? { x: xFingerprint, y: yFingerprint }
        : null,
  };
  cropCanvas.width = 1;
  cropCanvas.height = 1;
  return result;
}

export async function parseNovoExpressReport(
  file: ReportFile,
  onProgress: (progress: ParseProgress) => void,
  options: ParserOptions = {},
): Promise<ParsedReport> {
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    throw new Error("Choose a PDF report exported from NovoExpress.");
  }

  if (file.size > MAX_REPORT_BYTES) {
    throw new Error("This PDF is larger than 300 MB. Split the NovoExpress report first.");
  }

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (typeof window !== "undefined") {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
  }
  const createCanvas = options.createCanvas ?? createBrowserCanvas;

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
  });
  const documentProxy = await loadingTask.promise;
  const pageCount = documentProxy.numPages;
  const allStats = new Map<string, { sampleName: string; rows: StatsRow[] }>();
  const axisFingerprints = new Map<number, AxisFingerprint>();
  const rawPlots: RawPlot[] = [];
  let pendingPlots: PendingPlot[] = [];
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

  const assignPendingPlots = (section: StatsSection) => {
    if (pendingPlots.length === 0) {
      return;
    }

    const identity = sampleIdentity(section.sampleName);
    const structuralOccurrences = new Map<string, number>();

    for (const [plotIndex, pendingPlot] of pendingPlots.entries()) {
      const normalizedStructure = pendingPlot.structure
        ? normalizePlotStructure(pendingPlot.structure, section.rows)
        : null;
      const outputGates = normalizedStructure
        ? getOutputGates(normalizedStructure)
        : [];
      const matchedGate = outputGates.length > 0
        ? section.rows.find(
            (row) =>
              canonicalGate(row.gateName) === canonicalGate(outputGates[0]),
          )
        : undefined;
      const matchedStats =
        matchedGate ??
        (section.rows.length === pendingPlots.length
          ? section.rows[plotIndex]
          : undefined);
      const titleParts = pendingPlot.title
        ? parsePlotTitle(pendingPlot.title)
        : null;
      const parentPath = normalizedStructure
        ? getInputPopulationPath(
            normalizedStructure.inputPopulation,
            section.rows,
          )
        : titleParts?.parentPath && titleParts.parentPath !== "All events"
          ? titleParts.parentPath
          : matchedStats?.parentPath ?? "All events";
      let fallbackGroupKey: string | undefined;
      let fallbackGroupLabel: string | undefined;

      if (!section.hasAxisColumns) {
        const baseStructureKey = normalizedStructure
          ? [
              parentPath,
              normalizedStructure.inputPopulation,
              ...outputGates,
            ]
              .map((value) => canonicalGate(value))
              .join("::")
          : `unlabeled-layout-${pendingPlots.length}-${plotIndex}`;
        const occurrence = (structuralOccurrences.get(baseStructureKey) ?? 0) + 1;
        structuralOccurrences.set(baseStructureKey, occurrence);
        fallbackGroupKey = `native-layout::${baseStructureKey}::${occurrence}`;
        fallbackGroupLabel = normalizedStructure
          ? describePlotStructure(normalizedStructure)
          : `Unlabeled plot ${plotIndex + 1}`;
      }

      rawPlots.push({
        box: pendingPlot.box,
        documentIndex: pendingPlot.documentIndex,
        pageNumber: pendingPlot.pageNumber,
        ...identity,
        title: section.sampleName,
        parentPath,
        imageUrl: pendingPlot.imageUrl,
        fallbackGroupKey,
        fallbackGroupLabel,
        // A native plot table distinguishes "no displayed child gate" from
        // "gate metadata unavailable." Keep every child gate in report order;
        // the first item alone is not an adequate description of histograms
        // or quadrant plots.
        nativeOutputGateNames: normalizedStructure ? outputGates : null,
        fallbackGateName: normalizedStructure
          ? undefined
          : matchedStats?.gateName,
        isCompensation: pendingPlot.isCompensation,
      });
    }

    pendingPlots = [];
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

    const detectedPlots = extractPlotBoxes(page, operatorList, pdfjs);
    const boxes = detectedPlots.map((detectedPlot) => detectedPlot.box);
    const pagePlotEvents: Array<{
      type: "plot";
      y: number;
      plot: PendingPlot;
    }> = [];
    let pageCanvas: HTMLCanvasElement | null = null;

    if (detectedPlots.length > 0) {
      const renderViewport = page.getViewport({ scale: RENDER_SCALE });
      pageCanvas = createCanvas(
        Math.ceil(renderViewport.width),
        Math.ceil(renderViewport.height),
      );
      await page.render({ canvas: pageCanvas, viewport: renderViewport }).promise;

      for (const detectedPlot of detectedPlots) {
        const { box } = detectedPlot;
        const sourceImage = await getPlotImageData(page, detectedPlot);
        const axisSourceCanvas = sourceImage
          ? imageDataCanvas(sourceImage, pdfjs, createCanvas)
          : null;
        const croppedPlot = cropPlot(
          pageCanvas,
          box,
          RENDER_SCALE,
          createCanvas,
          axisSourceCanvas,
        );
        if (axisSourceCanvas) {
          axisSourceCanvas.width = 1;
          axisSourceCanvas.height = 1;
        }
        if (croppedPlot.axisFingerprint) {
          axisFingerprints.set(documentIndex, croppedPlot.axisFingerprint);
        }
        pagePlotEvents.push({
          type: "plot",
          y: box.y,
          plot: {
            box,
            documentIndex,
            pageNumber,
            title: getPlotTitle(box, rows),
            imageUrl: croppedPlot.imageUrl,
            structure: extractPlotStructure(box, boxes, rows),
            isCompensation: false,
          },
        });
        documentIndex += 1;
      }
    }

    const markerEvents: Array<{
      type: "compensation" | "specimen";
      y: number;
    }> = rows.flatMap((row): Array<{
      type: "compensation" | "specimen";
      y: number;
    }> => {
      const text = rowText(row);
      if (text === "Compensation Specimen") {
        return [{ type: "compensation" as const, y: row.y }];
      }
      if (/^Specimen\d+\b/.test(text)) {
        return [{ type: "specimen" as const, y: row.y }];
      }
      return [];
    });
    const statsEvents = pageStats.map((section) => ({
      type: "stats" as const,
      y: section.titleY,
      section,
    }));
    const pageEvents = [...markerEvents, ...pagePlotEvents, ...statsEvents].sort(
      (a, b) => a.y - b.y,
    );

    for (const event of pageEvents) {
      if (event.type === "compensation") {
        inCompensationSection = true;
      } else if (event.type === "specimen") {
        inCompensationSection = false;
      } else if (event.type === "plot") {
        event.plot.isCompensation = inCompensationSection;
        pendingPlots.push(event.plot);
      } else if (event.type === "stats") {
        assignPendingPlots(event.section);
      }
    }

    if (pageCanvas) {
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
  let usedStatsFallback = false;
  const unmatchedStatsSamples: string[] = [];
  for (const [, samplePlots] of plotsBySample) {
    const orderedPlots = samplePlots.sort(
      (a, b) => a.documentIndex - b.documentIndex,
    );
    const sampleStats = allStats.get(orderedPlots[0].statsKey);

    const statsMismatch = sampleStats?.rows.length !== orderedPlots.length;
    const usesNativeStructure = orderedPlots.some((plot) =>
      plot.fallbackGroupKey?.startsWith("native-layout::"),
    );
    const needsPositionalFallback =
      !usesNativeStructure &&
      !orderedPlots.every((plot) => plot.isCompensation) &&
      statsMismatch;
    usedStatsFallback ||= needsPositionalFallback;

    if (!sampleStats) {
      unmatchedStatsSamples.push(orderedPlots[0].sampleName);
    } else if (needsPositionalFallback) {
      warnings.push(
        `${orderedPlots[0].sampleName} has ${orderedPlots.length} plots but ${sampleStats.rows.length} statistics rows. Review its gate labels.`,
      );
    }

    orderedPlots.forEach((plot, indexInSample) => {
      const statsRow = statsMismatch
        ? undefined
        : sampleStats?.rows[indexInSample];
      const axisX = statsRow?.axisX || "Embedded in plot image";
      const axisY = statsRow?.axisY || "Embedded in plot image";
      const displayedGateNames =
        plot.nativeOutputGateNames ??
        (statsRow?.gateName
          ? [statsRow.gateName]
          : plot.fallbackGateName
            ? [plot.fallbackGateName]
            : []);
      const hasTextAxes = Boolean(statsRow?.axisX && statsRow.axisY);
      const groupLabel = hasTextAxes
        ? `${axisX} vs ${axisY}`
        : plot.fallbackGroupLabel ?? `Plot ${indexInSample + 1}`;

      parsedPlots.push({
        ...plot,
        id: `${plot.pageNumber}-${plot.documentIndex}`,
        axisX,
        axisY,
        displayedGateNames,
        groupKey: "",
        groupLabel,
        indexInSample,
      });
    });
  }

  type AxisGroupResolution = {
    key: string;
    label: string;
    labelConfidence: number;
    axisX: string;
    axisY: string;
    fingerprints: AxisFingerprint[];
    plots: ParsedPlot[];
  };

  const orderedParsedPlots = parsedPlots.sort(
    (a, b) => a.documentIndex - b.documentIndex,
  );
  const axisGroups: AxisGroupResolution[] = [];
  const textAxisGroups = new Map<string, AxisGroupResolution>();
  let imageGroupIndex = 0;
  let usedAxisFallback = false;
  let usedUnidentifiedAxisLabels = false;

  const hasTextAxes = (plot: ParsedPlot) =>
    plot.axisX !== "Embedded in plot image" &&
    plot.axisY !== "Embedded in plot image";

  const inferredAxes = (plot: ParsedPlot) => {
    if (plot.displayedGateNames.length === 0) {
      return {
        label: plot.groupLabel,
        axisX: plot.axisX,
        axisY: plot.axisY,
        confidence: 1,
      };
    }
    const gateKeys = new Set(
      plot.displayedGateNames.map((gateName) => canonicalGate(gateName)),
    );
    const parentKey = canonicalGate(plot.parentPath);
    if (
      (gateKeys.has("cells") || gateKeys.has("e1")) &&
      parentKey === "allevents"
    ) {
      return {
        label: "FSC-H vs SSC-H",
        axisX: "FSC-H",
        axisY: "SSC-H",
        confidence: 2,
      };
    }
    if (
      (gateKeys.has("singlets") && parentKey.includes("cells")) ||
      (gateKeys.has("p2") && parentKey.includes("e1"))
    ) {
      return {
        label: "FSC-H vs FSC-A",
        axisX: "FSC-H",
        axisY: "FSC-A",
        confidence: 2,
      };
    }
    return {
      label: plot.groupLabel,
      axisX: plot.axisX,
      axisY: plot.axisY,
      confidence: 1,
    };
  };

  const applyGroupDetails = (
    plot: ParsedPlot,
    group: AxisGroupResolution,
  ) => {
    plot.groupKey = group.key;
    plot.groupLabel = group.label;
    plot.axisX = group.axisX;
    plot.axisY = group.axisY;
  };

  const addFingerprint = (
    group: AxisGroupResolution,
    fingerprint: AxisFingerprint | undefined,
  ) => {
    if (!fingerprint || group.fingerprints.length >= 6) {
      return;
    }
    const alreadyRepresented = group.fingerprints.some((candidate) => {
      const comparison = compareAxisFingerprints(candidate, fingerprint);
      return comparison.x <= 0.01 && comparison.y <= 0.01;
    });
    if (!alreadyRepresented) {
      group.fingerprints.push(fingerprint);
    }
  };

  for (const plot of orderedParsedPlots.filter(hasTextAxes)) {
    const key = `axes-text::${[plot.axisX, plot.axisY]
      .map((value) => normalizeText(value).toLocaleLowerCase())
      .join("::")}`;
    const group = textAxisGroups.get(key) ?? {
      key,
      label: `${plot.axisX} vs ${plot.axisY}`,
      labelConfidence: 3,
      axisX: plot.axisX,
      axisY: plot.axisY,
      fingerprints: [],
      plots: [],
    };
    applyGroupDetails(plot, group);
    group.plots.push(plot);
    addFingerprint(group, axisFingerprints.get(plot.documentIndex));
    if (!textAxisGroups.has(key)) {
      textAxisGroups.set(key, group);
      axisGroups.push(group);
    }
  }

  for (const plot of orderedParsedPlots.filter((candidate) => !hasTextAxes(candidate))) {
    const fingerprint = axisFingerprints.get(plot.documentIndex);
    let bestMatch:
      | {
          score: number;
          group: AxisGroupResolution;
        }
      | undefined;

    if (fingerprint) {
      for (const group of axisGroups) {
        for (const candidate of group.fingerprints) {
          const comparison = compareAxisFingerprints(candidate, fingerprint);
          if (!comparison.matches) {
            continue;
          }
          const score = Math.max(comparison.x, comparison.y);
          if (!bestMatch || score < bestMatch.score) {
            bestMatch = { score, group };
          }
        }
      }
    }

    let group = bestMatch?.group;
    if (!group) {
      const fallbackKey = fingerprint
        ? `axes-image::${imageGroupIndex}`
        : `axes-fallback::${
            plot.fallbackGroupKey ??
            `position-${plot.indexInSample + 1}`
          }`;
      group = axisGroups.find((candidate) => candidate.key === fallbackKey);
      if (!group) {
        const details = inferredAxes(plot);
        group = {
          key: fallbackKey,
          label:
            fingerprint && details.confidence === 1
              ? "Axis labels unavailable"
              : details.label,
          labelConfidence: details.confidence,
          axisX: details.axisX,
          axisY: details.axisY,
          fingerprints: [],
          plots: [],
        };
        axisGroups.push(group);
        if (fingerprint) {
          imageGroupIndex += 1;
        } else {
          usedAxisFallback = true;
        }
      }
    }

    const details = inferredAxes(plot);
    if (details.confidence > group.labelConfidence) {
      group.label = details.label;
      group.labelConfidence = details.confidence;
      group.axisX = details.axisX;
      group.axisY = details.axisY;
      for (const groupedPlot of group.plots) {
        applyGroupDetails(groupedPlot, group);
      }
    }

    applyGroupDetails(plot, group);
    group.plots.push(plot);
    addFingerprint(group, fingerprint);
  }

  for (const group of axisGroups) {
    if (
      group.key.startsWith("axes-text::") ||
      group.fingerprints.length === 0
    ) {
      continue;
    }

    const identifiedX = identifyAxisLabel(group.fingerprints, "x");
    const identifiedY = identifyAxisLabel(group.fingerprints, "y");
    if (!identifiedX || !identifiedY) {
      usedUnidentifiedAxisLabels = true;
      continue;
    }

    group.label = `${identifiedX.label} vs ${identifiedY.label}`;
    group.labelConfidence = 3;
    group.axisX = identifiedX.label;
    group.axisY = identifiedY.label;
    for (const groupedPlot of group.plots) {
      applyGroupDetails(groupedPlot, group);
    }
  }

  const groups = axisGroups
    .filter((group) => group.plots.length > 0)
    .sort(
      (a, b) =>
        a.plots[0].documentIndex - b.plots[0].documentIndex,
    )
    .map((group): PlotGroup => ({
      key: group.key,
      label: group.label,
      parentPaths: [
        ...new Set(group.plots.map((plot) => plot.parentPath)),
      ],
      axisX: group.axisX,
      axisY: group.axisY,
      plots: group.plots,
    }));

  if (unmatchedStatsSamples.length > 0) {
    const examples = unmatchedStatsSamples.slice(0, 3).join(", ");
    warnings.push(
      `${unmatchedStatsSamples.length} sample layout${unmatchedStatsSamples.length === 1 ? "" : "s"} had no matching statistics table${examples ? ` (for example: ${examples})` : ""}. Review their gate labels.`,
    );
  }
  if (usedUnidentifiedAxisLabels) {
    warnings.unshift(
      "Some image-only axis captions could not be identified. They are left unavailable rather than guessed.",
    );
  }
  if (usedStatsFallback) {
    warnings.push(
      "Some plots did not have matching statistics rows, so their gate labels may use plot position. Axis grouping still uses the labels printed in each plot.",
    );
  }
  if (usedAxisFallback) {
    warnings.push(
      "Some plots did not expose a reliable X/Y label image, so those plots use their report layout as a fallback. Review those groups before export.",
    );
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
