import { PrivacyExperiments } from "./PrivacyExperiments";
import { summarizeFlows } from "./privacy.logic";
import { PrivacyOverview } from "./PrivacyOverview";
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
  const [view, setView] = useState("overview");
  const [outcome, setOutcome] = useState("all");
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
  const destinations = summarizeFlows(data?.events ?? []);
  const maximum = Math.max(1, ...destinations.map((entry) => entry.attempted));
  const events = (data?.events ?? [])
    .filter(
      (event) =>
        [event.host, event.source, event.category, ...event.fields]
          .join(" ")
          .toLowerCase()
          .includes(search.toLowerCase()) &&
        (outcome === "all" ||
          (outcome === "blocked"
            ? event.status === "blocked"
            : /^response \d+$/.test(event.status))) &&
        (!sensitiveOnly || event.findings.some((finding) => !finding.expected)),
    )
    .toReversed();
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <nav aria-label={"Privacy views"} className="flex flex-wrap gap-2 border-b pb-3">
        {(
          [
            ["overview", "Overview"],
            ["flows", "Data flows"],
            ["findings", "Findings"],
            ["experiments", "Experiments"],
            ["controls", "Controls"],
          ] as const
        ).map(([id, label]) => (
          <Button
            key={id}
            variant={view === id ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={view === id}
            onClick={() => setView(id)}
          >
            {label}
          </Button>
        ))}
      </nav>
      {view === "controls" ? (
        <PrivacyControlsPanel environmentId={environmentId} />
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold">
                {view === "overview" ? (
                  <span>Evidence at a glance</span>
                ) : view === "flows" ? (
                  <span>Data flows</span>
                ) : view === "findings" ? (
                  <span>Findings</span>
                ) : (
                  <span>Experiments</span>
                )}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                <span>Observe first. Blocks are manual and affect only this proxy.</span>
              </p>
            </div>
            <Button variant="outline" size="sm" disabled={query.isPending} onClick={refresh}>
              <span>Refresh</span>
            </Button>
          </div>
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
              <details>
                <summary className="cursor-pointer text-sm">
                  <span>Advanced observer setup</span>
                </summary>
                <p className="mt-3 text-sm">
                  <span>
                    On the selected machine, start the privacy observer, set the server's
                    connection-file variable to the file it prints, then restart that server. Route
                    a test provider through its proxy to begin capture.
                  </span>
                </p>
                <pre className="overflow-auto rounded bg-muted p-3 text-xs">
                  {
                    "vp run privacy:observe\nT3CODE_PRIVACY_OBSERVER_FILE=/absolute/path/.t3-privacy/observer.json"
                  }
                </pre>
                <p className="text-sm text-muted-foreground">
                  <span>
                    Saved policies survive observer restarts. Live observations are bounded;
                    temporary blocks expire at their recorded time.
                  </span>
                </p>
              </details>
            </div>
          ) : (
            <>
              {view === "overview" ? (
                <PrivacyOverview journal={data} refreshing={query.isPending} />
              ) : null}
              {view === "findings" ? (
                <PrivacyFindings
                  journal={data}
                  canChange={canChange}
                  pending={pending}
                  apply={apply}
                />
              ) : null}
              {view === "flows" ? (
                <>
                  <section className="space-y-3 rounded-lg border p-4">
                    <h3 className="font-medium">
                      <span>Payload evidence by destination</span>
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      <span>
                        Retained events only. Attempted bytes include blocked payloads. Responses
                        and forwarding signals do not confirm recipient delivery.
                      </span>
                    </p>
                    {destinations.map(({ host, attempted, blocked, responses, forwarding }) => (
                      <div key={host}>
                        <div className="flex justify-between gap-3 text-xs">
                          <span className="break-all">{host}</span>
                          <span>
                            {attempted.toLocaleString()} B · <span>attempted</span>
                          </span>
                        </div>
                        <div className="mt-1 h-2 rounded bg-primary/15">
                          <div
                            className="h-2 rounded bg-primary"
                            style={{ width: `${Math.max(1, (attempted / maximum) * 100)}%` }}
                          />
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {blocked.toLocaleString()} B <span>blocked</span> · {responses}{" "}
                          <span>upstream responses</span> · {forwarding}{" "}
                          <span>forwarding signals</span>
                        </p>
                      </div>
                    ))}
                  </section>
                </>
              ) : null}
              {view === "experiments" ? (
                <PrivacyExperiments
                  journal={data}
                  canChange={canChange}
                  pending={pending}
                  apply={apply}
                />
              ) : null}
              {view === "flows" ? (
                <>
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="min-w-48 flex-1">
                      <Input
                        aria-label={"Search source, destination or fields"}
                        placeholder={"Search source, destination or fields"}
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                      />
                    </div>
                    <select
                      aria-label={"Outcome filter"}
                      className="rounded border bg-background p-2 text-sm"
                      value={outcome}
                      onChange={(event) => setOutcome(event.target.value)}
                    >
                      <option value="all">{"All outcomes"}</option>
                      <option value="blocked">{"Blocked"}</option>
                      <option value="responses">{"Upstream response"}</option>
                    </select>
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
                              <details>
                                <summary className="cursor-pointer">
                                  <span>Inspect masked metadata</span>
                                </summary>
                                <p className="my-2 text-muted-foreground">
                                  <span>
                                    Provider and session attribution: unknown. Source is
                                    operator-supplied; category is inferred.
                                  </span>
                                </p>
                                {event.method} · {event.bodyBytes.toLocaleString()} B
                                <div>{event.fields.join(", ")}</div>
                                <div className="text-muted-foreground">{event.inspection}</div>
                                {event.scanTruncated ? (
                                  <div className="text-destructive">
                                    <span>Only the first 1 MiB was scanned.</span>
                                  </div>
                                ) : null}
                              </details>
                            </td>
                            <td className="p-3">
                              {event.findings.length ? (
                                groupFindings(event.findings).map(({ key, ...finding }) => (
                                  <div
                                    key={key}
                                    className={
                                      finding.expected
                                        ? "text-muted-foreground"
                                        : "text-destructive"
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
                                        ? data.rules?.some(
                                            (rule) =>
                                              rule.host ===
                                                event.host.toLowerCase().replace(/\.$/, "") &&
                                              rule.kind === "saved",
                                          )
                                          ? "remove-policy"
                                          : "unblock"
                                        : "block",
                                      host: event.host,
                                    })
                                  }
                                >
                                  {data.blocked.includes(
                                    event.host.toLowerCase().replace(/\.$/, ""),
                                  ) ? (
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
                          No matching observations. Run a task through the observer to see its
                          traffic.
                        </span>
                      </p>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    <span>
                      Errors can follow partial forwarding; WebSocket signals do not confirm
                      delivery. Up to 2,000 events are retained in memory. Source labels are
                      operator-supplied; purposes are inferred. Self-hosted services may make
                      further outbound requests that need separate observation.
                    </span>
                  </p>
                </>
              ) : null}
            </>
          )}
        </>
      )}
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
