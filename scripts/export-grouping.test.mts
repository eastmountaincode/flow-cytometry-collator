import assert from "node:assert/strict";
import test from "node:test";

import {
  getExportPages,
  getExportSections,
} from "../src/lib/export-grouping.ts";
import type {
  ParsedPlot,
  ParsedReport,
  PlotGroup,
} from "../src/lib/novoexpress-parser.ts";

function makePlot(
  id: string,
  sampleName: string,
  groupLabel: string,
  indexInSample: number,
  documentIndex: number,
  sampleKey = sampleName.toLocaleLowerCase(),
): ParsedPlot {
  return {
    id,
    sampleName,
    sampleKey,
    statsKey: sampleName.toLocaleLowerCase(),
    title: sampleName,
    groupKey: groupLabel.toLocaleLowerCase(),
    groupLabel,
    axisX: groupLabel.split(" vs ")[0],
    axisY: groupLabel.split(" vs ")[1],
    displayedGateNames: [],
    parentPath: "All events",
    imageUrl: "data:image/jpeg;base64,",
    pageNumber: 1,
    documentIndex,
    indexInSample,
    nativeOutputGateNames: [],
    isCompensation: false,
    box: { x: 0, y: 0, width: 100, height: 100 },
  };
}

function makeReport(): ParsedReport {
  const sampleAPlot2 = makePlot(
    "a-2",
    "Sample A",
    "FSC-H vs FSC-A",
    1,
    2,
  );
  const sampleBPlot1 = makePlot(
    "b-1",
    "Sample B",
    "FSC-H vs SSC-H",
    0,
    3,
  );
  const sampleAPlot1 = makePlot(
    "a-1",
    "Sample A",
    "FSC-H vs SSC-H",
    0,
    1,
  );
  const plots = [sampleAPlot2, sampleBPlot1, sampleAPlot1];
  const groups: PlotGroup[] = [
    {
      key: "scatter",
      label: "FSC-H vs SSC-H",
      parentPaths: ["All events"],
      axisX: "FSC-H",
      axisY: "SSC-H",
      plots: [sampleAPlot1, sampleBPlot1],
    },
    {
      key: "singlets",
      label: "FSC-H vs FSC-A",
      parentPaths: ["All events"],
      axisX: "FSC-H",
      axisY: "FSC-A",
      plots: [sampleAPlot2],
    },
  ];

  return {
    fileName: "report.pdf",
    reportTitle: "Report",
    metadata: {
      fileName: "report",
      cytometer: null,
      runTime: null,
      software: null,
    },
    pageCount: 1,
    sampleNames: ["Sample A", "Sample B"],
    plots,
    groups,
    warnings: [],
  };
}

test("keeps the parser's plot-type groups and order", () => {
  const report = makeReport();
  const sections = getExportSections(report, "plot-type");

  assert.deepEqual(
    sections.map((section) => section.label),
    ["FSC-H vs SSC-H", "FSC-H vs FSC-A"],
  );
  assert.deepEqual(
    sections[0].plots.map((plot) => plot.id),
    ["a-1", "b-1"],
  );
});

test("keeps separate plot groups even when their labels match", () => {
  const report = makeReport();
  report.groups[1].label = report.groups[0].label;

  const sections = getExportSections(report, "plot-type");

  assert.deepEqual(
    sections.map((section) => section.key),
    ["scatter", "singlets"],
  );
});

test("groups every plot for a sample in first-appearance order", () => {
  const sections = getExportSections(makeReport(), "sample");

  assert.deepEqual(
    sections.map((section) => section.label),
    ["Sample A", "Sample B"],
  );
  assert.deepEqual(
    sections[0].plots.map((plot) => plot.id),
    ["a-1", "a-2"],
  );
  assert.deepEqual(
    sections[1].plots.map((plot) => plot.id),
    ["b-1"],
  );
});

test("keeps repeated sample occurrences separate by sample key", () => {
  const report = makeReport();
  report.plots = [
    makePlot(
      "a-1",
      "Sample A",
      "FSC-H vs SSC-H",
      0,
      1,
      "sample-a::1",
    ),
    makePlot(
      "a-2",
      "Sample A (2)",
      "FSC-H vs SSC-H",
      0,
      2,
      "sample-a::2",
    ),
  ];

  const sections = getExportSections(report, "sample");

  assert.deepEqual(
    sections.map((section) => section.label),
    ["Sample A", "Sample A (2)"],
  );
});

test("includes every report plot exactly once in either grouping", () => {
  const report = makeReport();
  const expectedIds = report.plots.map((plot) => plot.id).sort();

  for (const grouping of ["plot-type", "sample"] as const) {
    const exportedIds = getExportSections(report, grouping)
      .flatMap((section) => section.plots)
      .map((plot) => plot.id)
      .sort();
    assert.deepEqual(exportedIds, expectedIds);
  }
});

test("continues a sample after six plots without shrinking the page size", () => {
  const report = makeReport();
  report.plots = Array.from({ length: 7 }, (_, index) =>
    makePlot(
      `a-${index + 1}`,
      "Sample A",
      `Plot ${index + 1}`,
      index,
      index,
    ),
  );
  report.sampleNames = ["Sample A"];

  const pages = getExportPages(report, "sample");

  assert.equal(pages.length, 2);
  assert.deepEqual(
    pages.map(({ firstPlot, lastPlot, part, partCount }) => ({
      firstPlot,
      lastPlot,
      part,
      partCount,
    })),
    [
      { firstPlot: 1, lastPlot: 6, part: 1, partCount: 2 },
      { firstPlot: 7, lastPlot: 7, part: 2, partCount: 2 },
    ],
  );
});
