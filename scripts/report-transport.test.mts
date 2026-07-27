import assert from "node:assert/strict";
import test from "node:test";

import { splitReportStreamRecords } from "../src/lib/report-transport.ts";

test("splits a buffered NDJSON response into individual records", () => {
  const responseText = [
    JSON.stringify({ type: "progress", progress: { percent: 50 } }),
    JSON.stringify({ type: "report", report: { plots: [], groups: [] } }),
    "",
  ].join("\n");

  assert.deepEqual(splitReportStreamRecords(responseText), [
    '{"type":"progress","progress":{"percent":50}}',
    '{"type":"report","report":{"plots":[],"groups":[]}}',
  ]);
});

test("accepts CRLF records and ignores empty lines", () => {
  assert.deepEqual(splitReportStreamRecords('{"type":"progress"}\r\n\r\n'), [
    '{"type":"progress"}',
  ]);
});
