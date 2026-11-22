import { useAtomValue } from "@effect/atom-react";
import {
  AuthDiagnosticsReadScope,
  AuthRelayReadScope,
  type EnvironmentId,
  type PrivacyProviderChange,
} from "@t3tools/contracts";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "../ui/button";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { privacy } from "../../state/privacy";
import { serverEnvironment } from "../../state/server";
import { resolveRelayTracingConfig } from "../../cloud/publicConfig";

export function PrivacyControlsPanel({ environmentId }: { environmentId: EnvironmentId }) {
  const canReadActivity = useEnvironmentScope(environmentId, AuthRelayReadScope);
  const activity = useEnvironmentQuery(
    canReadActivity ? privacy.activity({ environmentId, input: {} }) : null,
  );
  const canChangeActivity = useAtomValue(privacy.activityChange.permissionAtom(environmentId));
  const changeActivity = useAtomCommand(privacy.activityChange);
  const activityValue = activity.isSuccess ? activity.data : null;
  const canRead = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const query = useEnvironmentQuery(
    canRead ? privacy.controls({ environmentId, input: {} }) : null,
  );
  const canManage = useAtomValue(privacy.providerChange.permissionAtom(environmentId));
  const canSave = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const changeProvider = useAtomCommand(privacy.providerChange);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings);
  const [pending, setPending] = useState(false);
  const data = query.isSuccess ? query.data : null;
  async function applyActivity() {
    if (!canChangeActivity || pending || activityValue === null) return;
    setPending(true);
    const result = await changeActivity({
      environmentId,
      input: { enabled: !activityValue },
    }).finally(() => setPending(false));
    if (result._tag === "Success") activity.refresh();
  }
  async function apply(input: PrivacyProviderChange) {
    if (!canManage || pending) return;
    setPending(true);
    const result = await changeProvider({ environmentId, input }).finally(() => setPending(false));
    if (result._tag === "Success") query.refresh();
  }
  async function disableSavedDiagnostics() {
    if (!canSave || pending) return;
    setPending(true);
    const result = await updateSettings({
      environmentId,
      input: {
        patch: { observability: { otlpTracesUrl: "", otlpMetricsUrl: "", otlpLogsUrl: "" } },
      },
    }).finally(() => setPending(false));
    if (result._tag === "Success") query.refresh();
  }
  if (!canRead) return null;
  const browserTracing = resolveRelayTracingConfig() ? "on" : "off";
  return (
    <section className="mx-auto mb-6 max-w-6xl space-y-4 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">
          <span>Privacy controls and coverage</span>
        </h2>
        <Button variant="outline" size="sm" onClick={query.refresh} disabled={query.isPending}>
          <span>Refresh settings</span>
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        <span>
          Configuration describes requested behavior, not proof that traffic was captured or
          prevented. Provider changes can restart that provider. Finish active work before changing
          them.
        </span>
      </p>
      {query.error ? (
        <p role="alert" className="text-sm text-destructive">
          {query.error}
        </p>
      ) : null}
      {data ? (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2 rounded border p-3 text-sm">
              <p>
                <span>Server analytics startup setting</span>:{" "}
                <State value={data.serverTelemetry} />
              </p>
              <p>
                <span>Server relay tracing startup setting</span>:{" "}
                <State value={data.serverRelayTracing} />
              </p>
              <p className="text-muted-foreground">
                <span>
                  Host policy and desktop consent can further disable exports. To change these
                  startup settings, update the host environment and restart the server.
                </span>
              </p>
              <code className="block break-all text-xs">T3CODE_TELEMETRY_ENABLED=false</code>
            </div>
            <div className="space-y-2 rounded border p-3 text-sm">
              <p>
                <span>This client’s relay tracing</span>: <State value={browserTracing} />
              </p>
              <p>
                <span>Other browser and mobile clients</span>: <State value="unknown" />
              </p>
              <p className="text-muted-foreground">
                <span>
                  Mobile crash reporting and relay tracing are separate. Check diagnostics on each
                  device; server settings cannot verify or change an installed mobile build.
                </span>
              </p>
              <p>
                <span>Activity publishing</span>:{" "}
                <State value={activityValue === null ? "unknown" : activityValue ? "on" : "off"} />{" "}
                ·{" "}
                <Link to="/settings/connections" className="underline">
                  <span>Review sharing settings</span>
                </Link>
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={!canChangeActivity || pending || activityValue === null}
                onClick={() => void applyActivity()}
              >
                {activityValue ? <span>Disable</span> : <span>Enable</span>}
              </Button>
              {activity.error ? <p role="alert">{activity.error}</p> : null}
            </div>
          </div>
          <div className="space-y-2 rounded border p-3 text-sm">
            <h3 className="font-medium">
              <span>Custom diagnostics receivers</span>
            </h3>
            {data.customDiagnostics.map((signal) => (
              <p key={signal.signal}>
                {signal.signal}: <State value={signal.enabled ? "on" : "off"} />
                {signal.destination ? ` · ${signal.destination}` : ""} · {signal.source}
                {signal.savedEnabled !== signal.enabled ? (
                  <span>
                    {" "}
                    · <span>Saved setting differs from the running server</span>
                  </span>
                ) : null}
              </p>
            ))}
            <p className="text-muted-foreground">
              <span>
                These are the running server’s receivers. Saved changes require a server restart;
                environment overrides take precedence.
              </span>
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                variant="outline"
                disabled={
                  !canSave ||
                  pending ||
                  !data.customDiagnostics.some((signal) => signal.savedEnabled)
                }
                onClick={() => void disableSavedDiagnostics()}
              >
                <span>Clear saved receivers</span>
              </Button>
              <Link to="/settings/general" className="underline">
                <span>Configure diagnostics</span>
              </Link>
            </div>
          </div>
          <div className="space-y-3">
            <h3 className="font-medium">
              <span>Provider credentials and telemetry</span>
            </h3>
            <p className="text-sm text-muted-foreground">
              <span>
                Limit inherited environment variables with one click. Explicit provider credentials
                remain available. This does not prevent access to files owned by the same user or
                restrict network destinations.
              </span>
            </p>
            {data.hostAllowlist !== null ? (
              <p className="text-sm">
                <span>A host allowlist also applies. Provider settings cannot broaden it.</span>
              </p>
            ) : null}
            {data.providers.map((provider) => (
              <div key={provider.id} className="space-y-2 rounded border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="font-medium">
                    {provider.name}{" "}
                    <span className="font-normal text-muted-foreground">({provider.driver})</span>
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canManage || pending}
                    onClick={() =>
                      void apply({
                        action: "inheritance",
                        instanceId: provider.id,
                        restricted: provider.instanceAllowlist === null,
                      })
                    }
                  >
                    {provider.instanceAllowlist === null ? (
                      <span>Limit inherited variables</span>
                    ) : (
                      <span>Use host inheritance</span>
                    )}
                  </Button>
                </div>
                <p>
                  <span>Environment inheritance</span>:{" "}
                  {provider.inheritedEnvironment === "restricted" ? (
                    <span>Restricted by configuration</span>
                  ) : (
                    <span>Unrestricted</span>
                  )}{" "}
                  · {provider.explicitVariableCount} <span>explicit variables</span>
                </p>
                {provider.instanceAllowlist ? (
                  <details>
                    <summary>
                      <span>Allowed inherited variable names</span>
                    </summary>
                    <p className="mt-1 break-all text-xs">
                      {provider.instanceAllowlist.join(", ") || ""}
                    </p>
                  </details>
                ) : null}
                <p>
                  <span>Proxy setting</span>:{" "}
                  {provider.proxyConfigured ? (
                    <span>Configured; capture not verified</span>
                  ) : (
                    <span>Not configured in the reported environment</span>
                  )}
                </p>
                <p>
                  <span>Provider telemetry setting</span>: <State value={provider.telemetry} />
                </p>
                {provider.telemetryControl === "claude" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canManage || pending}
                    onClick={() =>
                      void apply({
                        action: "claude-telemetry",
                        instanceId: provider.id,
                        enabled: provider.telemetry === "off",
                      })
                    }
                  >
                    {provider.telemetry === "off" ? (
                      <span>Allow nonessential traffic</span>
                    ) : (
                      <span>Disable nonessential traffic</span>
                    )}
                  </Button>
                ) : (
                  <p className="text-muted-foreground">
                    {provider.telemetryControl === "launch-arguments" ? (
                      <span>
                        Codex defaults analytics off. Launch arguments may override it; runtime
                        behavior has not been verified.
                      </span>
                    ) : (
                      <span>
                        This provider owns its telemetry controls. No verified universal switch is
                        available.
                      </span>
                    )}
                  </p>
                )}
              </div>
            ))}
            <Link to="/settings/providers" className="text-sm underline">
              <span>Manage provider credentials and advanced settings</span>
            </Link>
          </div>
        </>
      ) : (
        <p className="text-sm">
          <span>Privacy controls require a compatible, connected server.</span>
        </p>
      )}
    </section>
  );
}
function State({ value }: { value: "on" | "off" | "unknown" }) {
  return (
    <strong>
      {value === "on" ? <span>On</span> : value === "off" ? <span>Off</span> : <span>Unknown</span>}
    </strong>
  );
}
