import assert from "node:assert/strict";
import test from "node:test";

import { formatDisplayedGates } from "../src/lib/report-labels.ts";

test("distinguishes a gate-free plot from unavailable gate metadata", () => {
  assert.equal(formatDisplayedGates([], "resolved"), "None");
  assert.equal(formatDisplayedGates([], "unavailable"), "Unavailable");
});
