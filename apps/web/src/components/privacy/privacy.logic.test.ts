import { expect, it } from "vite-plus/test";
import { groupFindings, hostsAbsentFromBaseline, summarizeFlows } from "./privacy.logic";

it("counts retained attempts separately from blocked bytes and upstream signals", () => {
  const event = {
    id: 1,
    time: 1,
    source: "operator",
    host: "example.test",
    method: "POST",
    category: "unknown",
    fields: [],
    scanTruncated: false,
    inspection: "unknown",
    findings: [],
  };
  expect(
    summarizeFlows([
      { ...event, status: "blocked", bodyBytes: 100 },
      { ...event, status: "response 500", bodyBytes: 20 },
      { ...event, status: "error: connection reset", bodyBytes: 30 },
      { ...event, status: "outbound WebSocket", bodyBytes: 40 },
      { ...event, status: "observed", bodyBytes: 50 },
    ]),
  ).toEqual([{ host: "example.test", attempted: 240, blocked: 100, responses: 1, forwarding: 1 }]);
  expect(summarizeFlows([])).toEqual([]);
});

it("compares only retained destinations and deduplicates hosts across later phases", () => {
  const entry = (host: string) => ({ host, observed: 1, blocked: 0, responses: 0, errors: 0 });
  expect(
    hostsAbsentFromBaseline({
      baseline: [entry("old.test")],
      blocked: [entry("old.test"), entry("other.test")],
      recovery: [entry("other.test"), entry("recovery.test")],
    }),
  ).toEqual(["other.test", "recovery.test"]);
  expect(hostsAbsentFromBaseline({ baseline: [], blocked: [], recovery: [] })).toEqual([]);
});

it("keeps structural contexts distinct and never backfills legacy finding flags", () => {
  const legacy = { kind: "authentication material", location: "header", count: 1, expected: true };
  const structural = {
    ...legacy,
    context: "schema" as const,
    detectorId: "detector.v1",
    valuePresence: "empty" as const,
  };
  const grouped = groupFindings([
    legacy,
    structural,
    structural,
    { ...structural, context: "authentication-shaped" },
  ]);
  expect(grouped).toHaveLength(3);
  expect(grouped[0]?.context).toBeUndefined();
  expect(grouped[0]?.detectorId).toBeUndefined();
  expect(grouped[1]?.count).toBe(2);
  expect(grouped[2]?.context).toBe("authentication-shaped");
});
