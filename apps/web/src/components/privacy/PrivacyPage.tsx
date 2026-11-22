import { PrivacyFindings } from "./PrivacyFindings";
import { PrivacyControlsPanel } from "./PrivacyControlsPanel";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthDiagnosticsReadScope,
  type EnvironmentId,
  type PrivacyRule,
  type PrivacyJournal,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { isElectron } from "../../env";
import { useNavigateToMainApp } from "../sidebar/mainAppLocation";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { XIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { privacy } from "../../state/privacy";

export function PrivacyPage() {
  const navigateToMainApp = useNavigateToMainApp();
  useEscapeToGoBack(() => {
    void navigateToMainApp();
  });
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  const environmentId =
    environments.find((env) => env.environmentId === (selected ?? primary))?.environmentId ??
    environments[0]?.environmentId;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron}>
        <SidebarTrigger />
        <h1 className="font-medium">
          <span>Privacy dashboard</span>
        </h1>
        <div className="ms-auto flex items-center gap-2">
          <select
            aria-label={"Machine"}
            value={environmentId ?? ""}
            onChange={(event) => {
              const match = environments.find((env) => env.environmentId === event.target.value);
              if (match) setSelected(match.environmentId);
            }}
            className="max-w-48 rounded-md border bg-background p-1 text-sm"
          >
            {environments.map((env) => (
              <option key={env.environmentId} value={env.environmentId}>
                {env.label}
              </option>
            ))}
          </select>
          <Button
            aria-label="Close"
            size="icon-sm"
            variant="ghost"
            onClick={() => void navigateToMainApp()}
          >
            <XIcon />
          </Button>
        </div>
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1 overflow-auto p-5">
        {environmentId ? (
          <div key={environmentId}>
            <PrivacyControlsPanel environmentId={environmentId} />
            <ObserverPanel environmentId={environmentId} />
          </div>
        ) : (
          <p>
            <span>Connect a machine to view its privacy dashboard.</span>
          </p>
        )}
      </div>
    </SidebarInset>
  );
}

function ObserverPanel({ environmentId }: { environmentId: EnvironmentId }) {
  const canRead = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const canChange = useAtomValue(privacy.change.permissionAtom(environmentId));
  const query = useEnvironmentQuery(
    canRead ? privacy.snapshot({ environmentId, input: {} }) : null,
  );
  const change = useAtomCommand(privacy.change);
  const [pending, setPending] = useState(false);
  const [hostname, setHostname] = useState("");
  const [search, setSearch] = useState("");
  const [sensitiveOnly, setSensitiveOnly] = useState(false);
  const data = query.isSuccess ? query.data : null;
  const refresh = query.refresh;
  const hasData = data !== null;
  useEffect(() => {
    if (!canRead || !hasData) return;
    const timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [canRead, hasData, refresh]);
  async function apply(rule: PrivacyRule) {
    if (pending || !canChange) return;
    setPending(true);
    const result = await change({ environmentId, input: rule }).finally(() => setPending(false));
    if (result._tag === "Success") refresh();
  }
  if (!canRead)
    return (
      <p role="status">
        <span>Diagnostics permission is required to view this machine's traffic.</span>
      </p>
    );
  const totals = new Map<string, number>();
  for (const event of data?.events ?? [])
    totals.set(event.host, (totals.get(event.host) ?? 0) + event.bodyBytes);
  const destinations = [...totals].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const maximum = Math.max(1, ...destinations.map(([, size]) => size));
  const events = (data?.events ?? [])
    .filter(
      (event) =>
        event.host.toLowerCase().includes(search.toLowerCase()) &&
        (!sensitiveOnly || event.findings.some((finding) => !finding.expected)),
    )
    .toReversed();
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">
            <span>Where your data goes</span>
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            <span>Observe first. Blocks are manual and affect only this proxy.</span>
          </p>
        </div>
        <Button variant="outline" size="sm" disabled={query.isPending} onClick={refresh}>
          <span>Refresh</span>
        </Button>
      </div>
      <p className="rounded-lg border p-3 text-sm text-muted-foreground">
        <span>
          Only traffic routed through the observer is visible. Detection can miss sensitive data.
          Raw payloads and matched values are never saved in this journal.
        </span>
      </p>
      {query.error ? (
        <p role="alert" className="text-sm text-destructive">
          {query.error}
        </p>
      ) : null}
      {!data ? (
        <div className="space-y-3 rounded-lg border p-4">
          <h3 className="font-medium">
            {query.isPending ? <span>Connecting</span> : <span>Connect the observer</span>}
          </h3>
          <p className="text-sm">
            <span>
              On the selected machine, start the privacy observer, set the server's connection-file
              variable to the file it prints, then restart that server. Route a test provider
              through its proxy to begin capture.
            </span>
          </p>
          <pre className="overflow-auto rounded bg-muted p-3 text-xs">
            {
              "vp run privacy:observe\nT3CODE_PRIVACY_OBSERVER_FILE=/absolute/path/.t3-privacy/observer.json"
            }
          </pre>
          <p className="text-sm text-muted-foreground">
            <span>
              The observer starts with no blocks. Stopping it clears observations and rules.
            </span>
          </p>
        </div>
      ) : (
        <>
          <PrivacyFindings journal={data} canChange={canChange} pending={pending} apply={apply} />
          <p className="text-sm text-muted-foreground">{data.label}</p>
          <div className="grid grid-cols-3 gap-3">
            <Stat value={data.observed} label={"Requests observed"} />
            <Stat
              value={
                data.events.filter((event) => event.findings.some((finding) => !finding.expected))
                  .length
              }
              label={"Possible sensitive data"}
            />
            <Stat value={data.blocked.length} label={"Blocked hosts"} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <section className="space-y-3 rounded-lg border p-4">
              <h3 className="font-medium">
                <span>Destinations · outbound body bytes</span>
              </h3>
              {destinations.map(([host, size]) => (
                <div key={host}>
                  <div className="flex justify-between gap-3 text-xs">
                    <span className="break-all">{host}</span>
                    <span>{size.toLocaleString()} B</span>
                  </div>
                  <div className="mt-1 h-2 rounded bg-primary/15">
                    <div
                      className="h-2 rounded bg-primary"
                      style={{ width: `${Math.max(1, (size / maximum) * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </section>
            <section className="space-y-3 rounded-lg border p-4">
              <h3 className="font-medium">
                <span>Block experiments</span>
              </h3>
              <p className="text-sm text-muted-foreground">
                <span>Block an exact host, retry your task, then unblock it to compare.</span>
              </p>
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void apply({ action: "block", host: hostname.trim() });
                }}
              >
                <Input
                  aria-label={"Exact hostname"}
                  placeholder="api.example.com"
                  value={hostname}
                  onChange={(event) => setHostname(event.target.value)}
                  required
                  disabled={!canChange || pending}
                />
                <Button
                  size="sm"
                  variant="outline"
                  type="submit"
                  disabled={!canChange || pending || !hostname.trim()}
                >
                  <span>Block</span>
                </Button>
              </form>
              {data.blocked.map((host) => (
                <div className="flex items-center justify-between gap-2 text-sm" key={host}>
                  <span className="break-all">{host}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!canChange || pending}
                    onClick={() => void apply({ action: "unblock", host })}
                  >
                    <span>Unblock</span>
                  </Button>
                </div>
              ))}
              {!canChange ? (
                <p className="text-xs text-muted-foreground">
                  <span>
                    Settings permission is required to change rules or clear observations.
                  </span>
                </p>
              ) : null}
            </section>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-48 flex-1">
              <Input
                aria-label={"Filter destinations"}
                placeholder={"Filter destinations"}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={sensitiveOnly}
                onChange={(event) => setSensitiveOnly(event.target.checked)}
              />
              <span>Possible sensitive data</span>
            </label>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const url = URL.createObjectURL(
                  new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
                );
                const link = document.createElement("a");
                link.href = url;
                link.download = "t3-privacy-masked-report.json";
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
            >
              <span>Export masked report</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!canChange || pending}
              onClick={() => void apply({ action: "clear" })}
            >
              <span>Clear observations</span>
            </Button>
          </div>
          <div className="overflow-auto rounded-lg border">
            <table className="w-full text-left text-xs">
              <thead className="bg-muted">
                <tr>
                  <th className="p-3">
                    <span>Time / source</span>
                  </th>
                  <th className="p-3">
                    <span>Destination / purpose</span>
                  </th>
                  <th className="p-3">
                    <span>What was observed</span>
                  </th>
                  <th className="p-3">
                    <span>Sensitive-data signals</span>
                  </th>
                  <th className="p-3">
                    <span>Delivery / action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id} className="border-t align-top">
                    <td className="p-3">
                      {new Date(event.time * 1000).toLocaleTimeString()}
                      <div className="text-muted-foreground">{event.source}</div>
                    </td>
                    <td className="p-3">
                      <div className="break-all">{event.host}</div>
                      <div className="text-muted-foreground">{event.category}</div>
                    </td>
                    <td className="p-3">
                      {event.method} · {event.bodyBytes.toLocaleString()} B
                      <div>{event.fields.join(", ")}</div>
                      <div className="text-muted-foreground">{event.inspection}</div>
                      {event.scanTruncated ? (
                        <div className="text-destructive">
                          <span>Only the first 1 MiB was scanned.</span>
                        </div>
                      ) : null}
                    </td>
                    <td className="p-3">
                      {event.findings.length ? (
                        groupFindings(event.findings).map(({ key, ...finding }) => (
                          <div
                            key={key}
                            className={
                              finding.expected ? "text-muted-foreground" : "text-destructive"
                            }
                          >
                            {finding.kind} · {finding.location} ×{finding.count} ·{" "}
                            {finding.expected ? (
                              <span>Expected authentication</span>
                            ) : (
                              <span>Value masked</span>
                            )}
                          </div>
                        ))
                      ) : (
                        <span className="text-muted-foreground">
                          <span>No pattern matched</span>
                        </span>
                      )}
                    </td>
                    <td className="p-3">
                      {event.status}
                      <div>
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={!canChange || pending}
                          onClick={() =>
                            void apply({
                              action: data.blocked.includes(
                                event.host.toLowerCase().replace(/\.$/, ""),
                              )
                                ? "unblock"
                                : "block",
                              host: event.host,
                            })
                          }
                        >
                          {data.blocked.includes(event.host.toLowerCase().replace(/\.$/, "")) ? (
                            <span>Unblock</span>
                          ) : (
                            <span>Block</span>
                          )}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!events.length ? (
              <p className="p-8 text-center text-sm text-muted-foreground">
                <span>
                  No matching observations. Run a task through the observer to see its traffic.
                </span>
              </p>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            <span>
              Up to 2,000 events are retained in memory. Source labels are operator-supplied;
              purposes are inferred. Self-hosted services may make further outbound requests that
              need separate observation.
            </span>
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-2xl font-semibold">{value.toLocaleString()}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function groupFindings(findings: PrivacyJournal["events"][number]["findings"]) {
  const groups = new Map<string, (typeof findings)[number]>();
  for (const finding of findings) {
    const key = `${finding.kind}:${finding.location}:${finding.expected}`;
    groups.set(key, { ...finding, count: (groups.get(key)?.count ?? 0) + finding.count });
  }
  return [...groups].map(([key, finding]) => ({ key, ...finding }));
}
