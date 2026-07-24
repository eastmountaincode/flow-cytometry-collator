import type { PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

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
  nativeGateName?: string;
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

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

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

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
  });
  const documentProxy = await loadingTask.promise;
  const pageCount = documentProxy.numPages;
  const allStats = new Map<string, { sampleName: string; rows: StatsRow[] }>();
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
        nativeGateName:
          outputGates[0] ??
          matchedStats?.gateName ??
          normalizedStructure?.gateNames.at(-1),
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

    const boxes = extractPlotBoxes(page, operatorList, pdfjs);
    const pagePlotEvents: Array<{
      type: "plot";
      y: number;
      plot: PendingPlot;
    }> = [];
    let pageCanvas: HTMLCanvasElement | null = null;

    if (boxes.length > 0) {
      const renderViewport = page.getViewport({ scale: RENDER_SCALE });
      pageCanvas = document.createElement("canvas");
      pageCanvas.width = Math.ceil(renderViewport.width);
      pageCanvas.height = Math.ceil(renderViewport.height);
      await page.render({ canvas: pageCanvas, viewport: renderViewport }).promise;

      for (const box of boxes) {
        pagePlotEvents.push({
          type: "plot",
          y: box.y,
          plot: {
            box,
            documentIndex,
            pageNumber,
            title: getPlotTitle(box, rows),
            imageUrl: cropPlot(pageCanvas, box, RENDER_SCALE),
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
  let usedNativeStructure = false;
  let usedPositionalFallback = false;
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
    usedNativeStructure ||= usesNativeStructure;
    usedPositionalFallback ||= needsPositionalFallback;

    if (!sampleStats) {
      unmatchedStatsSamples.push(orderedPlots[0].sampleName);
    } else if (needsPositionalFallback) {
      warnings.push(
        `${orderedPlots[0].sampleName} has ${orderedPlots.length} plots but ${sampleStats.rows.length} statistics rows. Review its grouping.`,
      );
    }

    orderedPlots.forEach((plot, indexInSample) => {
      const compensationKey = plot.isCompensation
        ? `compensation::${plot.sampleKey}::${indexInSample}`
        : undefined;
      const layoutFallbackKey = compensationKey ?? plot.fallbackGroupKey ?? (
        statsMismatch ? `position-layout-${orderedPlots.length}-${indexInSample}` : undefined
      );
      const statsRow = layoutFallbackKey
        ? undefined
        : sampleStats?.rows[indexInSample];
      const axisX = statsRow?.axisX || "Embedded in plot image";
      const axisY = statsRow?.axisY || "Embedded in plot image";
      const gateName =
        plot.nativeGateName ??
        statsRow?.gateName ??
        (plot.isCompensation
          ? "Not listed"
          : `Plot position ${indexInSample + 1}`);
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
  if (usedNativeStructure) {
    warnings.unshift(
      "This report stores axis captions inside the plot images. Matching uses the selectable input-population and gate-table structure; compensation controls stay separate.",
    );
  }
  if (usedPositionalFallback) {
    warnings.push(
      "Some plots did not expose enough table structure for gate-based matching, so those plots use their position within the sample layout. Review those groups before export.",
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
      !axisKey.includes("rasterized") &&
      !axisKey.includes("embedded")
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
