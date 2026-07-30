import assert from "node:assert/strict";
import test from "node:test";

import {
  matchGateStatistics,
  normalizeKnownGatePath,
  type GatePlotCandidate,
  type GateStatisticsRow,
} from "../src/lib/gate-matching.ts";

const rows: GateStatisticsRow[] = [
  {
    gateName: "E1",
    parentPath: "All events",
    axisX: "FSC-H",
    axisY: "SSC-H",
  },
  {
    gateName: "P2",
    parentPath: "E1",
    axisX: "FSC-H",
    axisY: "FSC-A",
  },
  {
    gateName: "E3",
    parentPath: "E1 / P2",
    axisX: "APC-Cy7-H",
    axisY: "FSC-H",
  },
  ...["CD19+", "Q4-2", "CD19-", "Q4-4"].map(
    (gateName): GateStatisticsRow => ({
      gateName,
      parentPath: "E1 / P2 / E3",
      axisX: "APC-H",
      axisY: "Pacific Blue-H",
    }),
  ),
];

function plot(parentPath: string): GatePlotCandidate {
  return {
    parentPath,
    nativeOutputGateNames: null,
  };
}

test("matches ordinary, quadrant, and childless plots through the gate hierarchy", () => {
  const matches = matchGateStatistics(
    [
      plot("All events"),
      plot("E1"),
      plot("E1 / P2"),
      plot("E1 / P2 / E3"),
      plot("E1 / P2 / E3 / CD19+"),
      plot("E1 / P2 / E3 / CD19-"),
    ],
    rows,
  );

  assert.deepEqual(
    matches.map((match) => match?.rows.map((row) => row.gateName)),
    [
      ["E1"],
      ["P2"],
      ["E3"],
      ["CD19+", "Q4-2", "CD19-", "Q4-4"],
      [],
      [],
    ],
  );
  assert.ok(matches.every((match) => match !== null));
});

test("keeps same-parent plots separate when their child gates use different axes", () => {
  const histogramRows: GateStatisticsRow[] = [
    {
      gateName: "M3",
      parentPath: "E1 / P2",
      axisX: "Pacific Blue-H",
      axisY: "Count",
    },
    {
      gateName: "M4",
      parentPath: "E1 / P2",
      axisX: "FITC-H",
      axisY: "Count",
    },
  ];
  const matches = matchGateStatistics(
    [plot("E1 / P2"), plot("E1 / P2")],
    histogramRows,
  );

  assert.deepEqual(
    matches.map((match) => match?.rows.map((row) => row.gateName)),
    [["M3"], ["M4"]],
  );
});

test("does not call an ambiguous gate match empty", () => {
  const matches = matchGateStatistics(
    [plot("E1 / P2 / E3"), plot("E1 / P2 / E3")],
    rows,
  );

  assert.deepEqual(matches, [null, null]);
});

test("keeps native per-plot gates authoritative", () => {
  const matches = matchGateStatistics(
    [
      {
        parentPath: "E1 / P2 / E3",
        nativeOutputGateNames: ["CD19-", "Q4-4"],
      },
    ],
    rows,
  );

  assert.deepEqual(
    matches[0]?.rows.map((row) => row.gateName),
    ["CD19-", "Q4-4"],
  );
  assert.equal(matches[0]?.method, "native");
});

test("normalizes a selectable title path against the paired statistics tree", () => {
  assert.equal(
    normalizeKnownGatePath("e1 / p2 / e3 / cd19+", rows),
    "E1 / P2 / E3 / CD19+",
  );
  assert.equal(
    normalizeKnownGatePath("E1 / P2 E3", rows),
    null,
  );
});
