import assert from "node:assert/strict";
import test from "node:test";

import { joinNovoExpressPlotTitleLines } from "../src/lib/plot-title.ts";

test("excludes a gate annotation immediately below a complete title", () => {
  assert.equal(
    joinNovoExpressPlotTitleLines([
      "Sample1 / E1 / P2",
      "E3",
    ]),
    "Sample1 / E1 / P2",
  );
  assert.equal(
    joinNovoExpressPlotTitleLines([
      "Sample1 / E1 / P2 / E3",
      "CD19+ Q4-2",
    ]),
    "Sample1 / E1 / P2 / E3",
  );
});

test("keeps the continuation of a title that visibly ends with a slash", () => {
  assert.equal(
    joinNovoExpressPlotTitleLines([
      "Sample1 / E1 / P2 / E3 /",
      "CD19+",
    ]),
    "Sample1 / E1 / P2 / E3 / CD19+",
  );
});
