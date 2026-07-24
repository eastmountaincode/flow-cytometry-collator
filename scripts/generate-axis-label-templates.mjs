import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ImageKind,
  OPS,
  getDocument,
} from "pdfjs-dist/legacy/build/pdf.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, "..");
const FIXTURE_DIRECTORY = path.resolve(
  PROJECT_DIRECTORY,
  "../../input_data/example_pdfs",
);
const OUTPUT_FILE = path.join(
  PROJECT_DIRECTORY,
  "src/lib/axis-label-templates.generated.ts",
);

const FINGERPRINT_WIDTH = 64;
const FINGERPRINT_HEIGHT = 16;
const MATCH_THRESHOLD = 0.075;
const MATCH_MARGIN = 0.03;
const SEED_MATCH_THRESHOLD = 0.15;
const COVER_RADIUS = 0.02;
const FIXED_POINT = 65_536;
const FIXED_POINT_SQUARED = FIXED_POINT * FIXED_POINT;

const LABEL_ORDER = [
  "FSC-H",
  "FSC-A",
  "SSC-H",
  "Count",
  "GFP-H",
  "APC-Cy7-H",
  "PE-Texas Red/PI-H",
  "Ly6G APC-H",
  "CD45 Pacific Blue/BV421-H",
  "FITC-H",
  "APC-H",
  "PE-H",
  "Pacific Blue-H",
  "aGPA33 488-H",
  "mcherry-H",
];

// These examples were manually read from a contact sheet. The generator uses
// their shapes to label the rest of the fixture set; it never performs OCR.
// Fixtures are identified by plot count so private report filenames do not
// enter this public repository.
const LABELED_SEEDS = [
  {
    fixturePlots: 144,
    documentIndex: 0,
    axis: "x",
    label: "PE-H",
  },
  {
    fixturePlots: 144,
    documentIndex: 0,
    axis: "y",
    label: "Count",
  },
  {
    fixturePlots: 144,
    documentIndex: 1,
    axis: "x",
    label: "FSC-H",
  },
  {
    fixturePlots: 144,
    documentIndex: 1,
    axis: "y",
    label: "FSC-A",
  },
  {
    fixturePlots: 144,
    documentIndex: 2,
    axis: "y",
    label: "SSC-H",
  },
  {
    fixturePlots: 144,
    documentIndex: 48,
    axis: "x",
    label: "FITC-H",
  },
  {
    fixturePlots: 144,
    documentIndex: 96,
    axis: "x",
    label: "APC-H",
  },
  {
    fixturePlots: 96,
    documentIndex: 4,
    axis: "x",
    label: "Pacific Blue-H",
  },
  {
    fixturePlots: 96,
    documentIndex: 5,
    axis: "x",
    label: "APC-Cy7-H",
  },
  {
    fixturePlots: 96,
    documentIndex: 9,
    axis: "y",
    label: "PE-H",
  },
  {
    fixturePlots: 96,
    documentIndex: 12,
    axis: "y",
    label: "FITC-H",
  },
  {
    fixturePlots: 324,
    documentIndex: 0,
    axis: "x",
    label: "CD45 Pacific Blue/BV421-H",
  },
  {
    fixturePlots: 324,
    documentIndex: 1,
    axis: "x",
    label: "Ly6G APC-H",
  },
  {
    fixturePlots: 324,
    documentIndex: 2,
    axis: "x",
    label: "GFP-H",
  },
  {
    fixturePlots: 650,
    documentIndex: 1,
    axis: "x",
    label: "PE-Texas Red/PI-H",
  },
  {
    fixturePlots: 24,
    documentIndex: 0,
    axis: "x",
    label: "aGPA33 488-H",
  },
  {
    fixturePlots: 24,
    documentIndex: 1,
    axis: "x",
    label: "mcherry-H",
  },
];

function fingerprintDistance(first, second) {
  if (first.length !== second.length || first.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  let difference = 0;
  for (let index = 0; index < first.length; index += 1) {
    difference += Math.abs(first[index] - second[index]);
  }
  return difference / (first.length * 255);
}

function imageLuminance(image, x, y) {
  const channels = image.kind === ImageKind.RGBA_32BPP ? 4 : 3;
  const offset = (y * image.width + x) * channels;
  return (
    (image.data[offset] * 77 +
      image.data[offset + 1] * 150 +
      image.data[offset + 2] * 29) >>
    8
  );
}

function axisBand(image, axis) {
  if (
    !image.data ||
    (
      image.kind !== ImageKind.RGB_24BPP &&
      image.kind !== ImageKind.RGBA_32BPP
    )
  ) {
    throw new Error("The fixture plot image has an unsupported pixel format.");
  }

  const horizontal = axis === "x";
  const bandX = Math.floor(image.width * (horizontal ? 0.02 : 0.01));
  const bandY = Math.floor(image.height * (horizontal ? 0.895 : 0.06));
  const sourceWidth = Math.min(
    Math.max(1, Math.ceil(image.width * (horizontal ? 0.96 : 0.09))),
    image.width - bandX,
  );
  const sourceHeight = Math.min(
    Math.max(1, Math.ceil(image.height * (horizontal ? 0.1 : 0.8))),
    image.height - bandY,
  );
  const band = {
    width: horizontal ? sourceWidth : sourceHeight,
    height: horizontal ? sourceHeight : sourceWidth,
    luminance: new Uint8Array(sourceWidth * sourceHeight),
  };

  for (let y = 0; y < band.height; y += 1) {
    for (let x = 0; x < band.width; x += 1) {
      const sourceX = horizontal ? bandX + x : bandX + y;
      const sourceY = horizontal
        ? bandY + y
        : bandY + sourceHeight - x - 1;
      band.luminance[y * band.width + x] = imageLuminance(
        image,
        sourceX,
        sourceY,
      );
    }
  }
  return band;
}

function makeAxisFingerprint(image, axis) {
  const band = axisBand(image, axis);
  const luminanceAt = (x, y) => band.luminance[y * band.width + x];
  const isInk = (x, y) => luminanceAt(x, y) < 190;
  const findInkBounds = (maximumAllowedX = band.width - 1) => {
    let minimumX = band.width;
    let minimumY = band.height;
    let maximumX = -1;
    let maximumY = -1;
    let inkPixels = 0;

    for (let y = 0; y < band.height; y += 1) {
      for (
        let x = 0;
        x < band.width && x <= maximumAllowedX;
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
    throw new Error("An axis caption did not contain enough dark pixels.");
  }

  const columnRuns = [];
  let runStart = null;
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
    if (runStart !== null && (!hasInk || x === bounds.maximumX)) {
      columnRuns.push({
        start: runStart,
        end: hasInk && x === bounds.maximumX ? x : x - 1,
      });
      runStart = null;
    }
  }

  const axisLabelHeight = bounds.maximumY - bounds.minimumY + 1;
  if (
    axisLabelHeight >= image.height * 0.056 &&
    columnRuns.length >= 6
  ) {
    const precedingRunIndex = columnRuns.length - 6;
    const precedingRun = columnRuns[precedingRunIndex];
    const suffixStart = columnRuns[precedingRunIndex + 1];
    if (
      suffixStart.start - precedingRun.end - 1 >=
      image.width * 0.019
    ) {
      bounds = findInkBounds(precedingRun.end) ?? bounds;
    }
  }

  const sourceWidth = bounds.maximumX - bounds.minimumX + 1;
  const sourceHeight = bounds.maximumY - bounds.minimumY + 1;
  const fingerprint = new Uint8Array(
    FINGERPRINT_WIDTH * FINGERPRINT_HEIGHT,
  );

  for (let outputY = 0; outputY < FINGERPRINT_HEIGHT; outputY += 1) {
    const rawSourceY = Math.floor(
      (
        ((outputY * 2 + 1) * sourceHeight * FIXED_POINT) /
        (FINGERPRINT_HEIGHT * 2)
      ) - FIXED_POINT / 2,
    );
    const sourceYFixed = Math.max(
      0,
      Math.min((sourceHeight - 1) * FIXED_POINT, rawSourceY),
    );
    const sourceY = Math.floor(sourceYFixed / FIXED_POINT);
    const nextSourceY = Math.min(sourceHeight - 1, sourceY + 1);
    const yWeight = sourceYFixed - sourceY * FIXED_POINT;

    for (let outputX = 0; outputX < FINGERPRINT_WIDTH; outputX += 1) {
      const rawSourceX = Math.floor(
        (
          ((outputX * 2 + 1) * sourceWidth * FIXED_POINT) /
          (FINGERPRINT_WIDTH * 2)
        ) - FIXED_POINT / 2,
      );
      const sourceXFixed = Math.max(
        0,
        Math.min((sourceWidth - 1) * FIXED_POINT, rawSourceX),
      );
      const sourceX = Math.floor(sourceXFixed / FIXED_POINT);
      const nextSourceX = Math.min(sourceWidth - 1, sourceX + 1);
      const xWeight = sourceXFixed - sourceX * FIXED_POINT;
      const top =
        luminanceAt(bounds.minimumX + sourceX, bounds.minimumY + sourceY) *
          (FIXED_POINT - xWeight) +
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
          (FIXED_POINT - xWeight) +
        luminanceAt(
          bounds.minimumX + nextSourceX,
          bounds.minimumY + nextSourceY,
        ) *
          xWeight;
      const luminance = Math.floor(
        (
          top * (FIXED_POINT - yWeight) +
          bottom * yWeight +
          FIXED_POINT_SQUARED / 2
        ) / FIXED_POINT_SQUARED,
      );
      fingerprint[outputY * FINGERPRINT_WIDTH + outputX] =
        255 - luminance;
    }
  }
  return fingerprint;
}

async function readFixture(fileName) {
  const filePath = path.join(FIXTURE_DIRECTORY, fileName);
  const loadingTask = getDocument({
    data: new Uint8Array(fs.readFileSync(filePath)),
    disableWorker: true,
  });
  const documentProxy = await loadingTask.promise;
  const axes = [];
  let documentIndex = 0;

  for (
    let pageNumber = 1;
    pageNumber <= documentProxy.numPages;
    pageNumber += 1
  ) {
    const page = await documentProxy.getPage(pageNumber);
    const operatorList = await page.getOperatorList();
    for (let index = 0; index < operatorList.fnArray.length; index += 1) {
      const operation = operatorList.fnArray[index];
      if (
        operation !== OPS.paintImageXObject &&
        operation !== OPS.paintInlineImageXObject
      ) {
        continue;
      }
      const argument = operatorList.argsArray[index]?.[0];
      const image =
        operation === OPS.paintInlineImageXObject
          ? argument
          : page.objs.get(argument);
      if (!image || image.width < 90 || image.height < 90) {
        continue;
      }
      axes.push({
        documentIndex,
        axis: "x",
        fingerprint: makeAxisFingerprint(image, "x"),
      });
      axes.push({
        documentIndex,
        axis: "y",
        fingerprint: makeAxisFingerprint(image, "y"),
      });
      documentIndex += 1;
    }
    page.cleanup();
  }

  for (const item of axes) {
    item.fixturePlots = documentIndex;
  }
  await loadingTask.destroy();
  return axes;
}

function sourceKey(item) {
  return `${item.fixturePlots}::${item.documentIndex}::${item.axis}`;
}

function scoreLabels(fingerprint, templateSets) {
  return templateSets
    .map((templateSet) => ({
      label: templateSet.label,
      distance: Math.min(
        ...templateSet.fingerprints.map((template) =>
          fingerprintDistance(fingerprint, template),
        ),
      ),
    }))
    .sort((first, second) => first.distance - second.distance);
}

function classifyFingerprint(
  fingerprint,
  templateSets,
  threshold = MATCH_THRESHOLD,
) {
  const scores = scoreLabels(fingerprint, templateSets);
  const best = scores[0];
  const nextBest = scores[1];
  if (
    !best ||
    best.distance > threshold ||
    (
      nextBest &&
      nextBest.distance - best.distance < MATCH_MARGIN
    )
  ) {
    return null;
  }
  return { ...best, nextDistance: nextBest?.distance ?? Number.POSITIVE_INFINITY };
}

function packFingerprint(fingerprint) {
  const packed = new Uint8Array(fingerprint.length / 2);
  for (let index = 0; index < packed.length; index += 1) {
    const high = Math.max(
      0,
      Math.min(15, Math.round(fingerprint[index * 2] / 17)),
    );
    const low = Math.max(
      0,
      Math.min(15, Math.round(fingerprint[index * 2 + 1] / 17)),
    );
    packed[index] = (high << 4) | low;
  }
  return packed;
}

function unpackFingerprint(packed) {
  const fingerprint = new Uint8Array(packed.length * 2);
  for (let index = 0; index < packed.length; index += 1) {
    fingerprint[index * 2] = (packed[index] >> 4) * 17;
    fingerprint[index * 2 + 1] = (packed[index] & 0x0f) * 17;
  }
  return fingerprint;
}

function quantizeFingerprint(fingerprint) {
  return unpackFingerprint(packFingerprint(fingerprint));
}

function generatedSource(templateSets) {
  const lines = [
    "// Generated by scripts/generate-axis-label-templates.mjs.",
    "// The values are visual fingerprints of manually labeled axis captions;",
    "// no report data or sample names are included.",
    "",
    'export const AXIS_LABEL_TEMPLATE_FORMAT = "novo-axis-core-v2-q4" as const;',
    "",
    "export const AXIS_LABEL_TEMPLATE_SETS = [",
  ];
  for (const templateSet of templateSets) {
    lines.push("  {");
    lines.push(`    label: ${JSON.stringify(templateSet.label)},`);
    lines.push("    fingerprints: [");
    for (const fingerprint of templateSet.fingerprints) {
      lines.push(
        `      ${JSON.stringify(Buffer.from(packFingerprint(fingerprint)).toString("base64"))},`,
      );
    }
    lines.push("    ],");
    lines.push("  },");
  }
  lines.push("] as const;");
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const fixtureNames = fs
    .readdirSync(FIXTURE_DIRECTORY)
    .filter((fileName) => fileName.endsWith(".pdf") && !fileName.startsWith("._"))
    .sort();
  const axes = (
    await Promise.all(fixtureNames.map((fileName) => readFixture(fileName)))
  ).flat();
  const axesBySource = new Map(axes.map((item) => [sourceKey(item), item]));
  const seedSetsByLabel = new Map();

  for (const seed of LABELED_SEEDS) {
    const source = axesBySource.get(sourceKey(seed));
    if (!source) {
      throw new Error(`Missing labeled seed ${sourceKey(seed)}.`);
    }
    const fingerprints = seedSetsByLabel.get(seed.label) ?? [];
    fingerprints.push(source.fingerprint);
    seedSetsByLabel.set(seed.label, fingerprints);
  }

  const seedSets = LABEL_ORDER.map((label) => ({
    label,
    fingerprints: seedSetsByLabel.get(label) ?? [],
  }));
  for (const item of axes) {
    const match = classifyFingerprint(
      item.fingerprint,
      seedSets,
      SEED_MATCH_THRESHOLD,
    );
    if (!match) {
      const scores = scoreLabels(item.fingerprint, seedSets)
        .slice(0, 3)
        .map((score) => `${score.label}=${score.distance.toFixed(4)}`)
        .join(", ");
      throw new Error(
        `Could not label ${sourceKey(item)} from the seed set (${scores}).`,
      );
    }
    item.label = match.label;
  }

  const templateSets = LABEL_ORDER.map((label) => {
    const fingerprints = [];
    for (const item of axes.filter((candidate) => candidate.label === label)) {
      if (
        fingerprints.length === 0 ||
        Math.min(
          ...fingerprints.map((template) =>
            fingerprintDistance(item.fingerprint, template),
          ),
        ) > COVER_RADIUS
      ) {
        fingerprints.push(item.fingerprint);
      }
    }
    return { label, fingerprints };
  });
  const quantizedTemplateSets = templateSets.map((templateSet) => ({
    label: templateSet.label,
    fingerprints: templateSet.fingerprints.map(quantizeFingerprint),
  }));

  let maximumCorrectDistance = 0;
  let minimumWrongDistance = Number.POSITIVE_INFINITY;
  let minimumMargin = Number.POSITIVE_INFINITY;
  for (const item of axes) {
    const scores = scoreLabels(item.fingerprint, quantizedTemplateSets);
    const best = scores[0];
    const nextBest = scores[1];
    if (
      !best ||
      best.label !== item.label ||
      best.distance > MATCH_THRESHOLD ||
      nextBest.distance - best.distance < MATCH_MARGIN
    ) {
      throw new Error(`Generated templates misclassified ${sourceKey(item)}.`);
    }
    maximumCorrectDistance = Math.max(maximumCorrectDistance, best.distance);
    minimumWrongDistance = Math.min(minimumWrongDistance, nextBest.distance);
    minimumMargin = Math.min(
      minimumMargin,
      nextBest.distance - best.distance,
    );
  }

  const templateCount = templateSets.reduce(
    (total, templateSet) => total + templateSet.fingerprints.length,
    0,
  );
  if (axes.length !== 2_842 || templateSets.length !== 15) {
    throw new Error(
      `Unexpected fixture coverage: ${axes.length} axes, ${templateSets.length} labels.`,
    );
  }

  const source = generatedSource(templateSets);
  const mode = process.argv[2] ?? "--print";
  if (mode === "--write") {
    fs.writeFileSync(OUTPUT_FILE, source);
  } else if (mode === "--check") {
    const current = fs.readFileSync(OUTPUT_FILE, "utf8");
    if (current !== source) {
      throw new Error(
        "Axis label templates are stale. Run npm run axis-templates:generate.",
      );
    }
  } else if (mode === "--print") {
    process.stdout.write(source);
  } else {
    throw new Error(`Unknown mode ${mode}.`);
  }

  console.error(
    [
      `${axes.length} axes`,
      `${templateSets.length} labels`,
      `${templateCount} templates`,
      `max correct ${maximumCorrectDistance.toFixed(4)}`,
      `nearest wrong ${minimumWrongDistance.toFixed(4)}`,
      `min margin ${minimumMargin.toFixed(4)}`,
    ].join(" | "),
  );
}

await main();
