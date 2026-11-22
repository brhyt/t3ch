import { expect, it } from "vite-plus/test";
import { summarizeFlows } from "./privacy.logic";

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
