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
