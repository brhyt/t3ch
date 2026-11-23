import type { PrivacyJournal } from "@t3tools/contracts";

export function summarizeFlows(events: PrivacyJournal["events"]) {
  const hosts = new Map<
    string,
    { host: string; attempted: number; blocked: number; responses: number; forwarding: number }
  >();
  for (const event of events) {
    const entry = hosts.get(event.host) ?? {
      host: event.host,
      attempted: 0,
      blocked: 0,
      responses: 0,
      forwarding: 0,
    };
    entry.attempted += event.bodyBytes;
    if (event.status === "blocked") entry.blocked += event.bodyBytes;
    else if (/^response \d+$/.test(event.status)) entry.responses++;
    else if (event.status === "outbound WebSocket") entry.forwarding++;
    hosts.set(event.host, entry);
  }
  return [...hosts.values()].sort((a, b) => b.attempted - a.attempted);
}

export function hostsAbsentFromBaseline(
  destinations: NonNullable<NonNullable<PrivacyJournal["experiments"]>[number]["destinations"]>,
) {
  const baseline = new Set(destinations.baseline.map(({ host }) => host));
  return [
    ...new Set([...destinations.blocked, ...destinations.recovery].map(({ host }) => host)),
  ].filter((host) => !baseline.has(host));
}

export function groupFindings(findings: PrivacyJournal["events"][number]["findings"]) {
  const groups = new Map<string, (typeof findings)[number]>();
  for (const finding of findings) {
    const key = JSON.stringify([
      finding.kind,
      finding.location,
      finding.expected,
      finding.detectorId,
      finding.context,
      finding.destinationExpectation,
      finding.valuePresence,
      finding.valueType,
    ]);
    groups.set(key, { ...finding, count: (groups.get(key)?.count ?? 0) + finding.count });
  }
  return [...groups].map(([key, finding]) => ({ key, ...finding }));
}
