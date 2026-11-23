import type { PrivacyRule } from "@t3tools/contracts";
import { useState } from "react";
import { Input } from "../ui/input";
import { Button } from "../ui/button";

export function PrivacyExperimentMetadata({
  experimentId,
  metadata,
  disabled,
  apply,
}: {
  experimentId: string;
  metadata: PrivacyRule["metadata"];
  disabled: boolean;
  apply: (rule: PrivacyRule) => Promise<void>;
}) {
  const gt = (text: string) => text;
  const [taskRef, setTaskRef] = useState(metadata?.taskRef ?? "");
  const [provider, setProvider] = useState(metadata?.provider ?? "");
  const [providerVersion, setProviderVersion] = useState(metadata?.providerVersion ?? "");
  const [telemetry, setTelemetry] = useState(metadata?.settings?.telemetry ?? "unknown");
  const [proxy, setProxy] = useState(metadata?.settings?.proxy ?? "unknown");
  const [inheritance, setInheritance] = useState(metadata?.settings?.inheritance ?? "unknown");
  return (
    <details>
      <summary>
        <span>Operator-supplied</span>
      </summary>
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled)
            void apply({
              action: "experiment-metadata",
              experimentId,
              metadata: {
                provenance: "operator-asserted",
                ...(taskRef ? { taskRef } : {}),
                ...(provider ? { provider } : {}),
                ...(providerVersion ? { providerVersion } : {}),
                settings: { telemetry, proxy, inheritance },
              },
            });
        }}
      >
        {(
          [
            [gt("Safe task reference"), taskRef, setTaskRef],
            [gt("Provider"), provider, setProvider],
            [gt("Provider version"), providerVersion, setProviderVersion],
          ] as const
        ).map(([label, value, set]) => (
          <label className="block" key={label}>
            {label}
            <Input
              value={value}
              onChange={(event) => set(event.target.value)}
              pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}"
              maxLength={64}
              disabled={disabled}
            />
          </label>
        ))}
        <label className="block">
          <span>Telemetry</span>
          <select
            disabled={disabled}
            value={telemetry}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "on" || v === "off" || v === "unknown") setTelemetry(v);
            }}
          >
            <option value="unknown">{gt("Unknown")}</option>
            <option value="on">{gt("On")}</option>
            <option value="off">{gt("Off")}</option>
          </select>
        </label>
        <label className="block">
          <span>Proxy</span>
          <select
            disabled={disabled}
            value={proxy}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "configured" || v === "unknown") setProxy(v);
            }}
          >
            <option value="unknown">{gt("Unknown")}</option>
            <option value="configured">{gt("Configured")}</option>
          </select>
        </label>
        <label className="block">
          <span>Environment inheritance</span>
          <select
            disabled={disabled}
            value={inheritance}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "restricted" || v === "unrestricted" || v === "unknown") setInheritance(v);
            }}
          >
            <option value="unknown">{gt("Unknown")}</option>
            <option value="restricted">{gt("Restricted")}</option>
            <option value="unrestricted">{gt("Unrestricted")}</option>
          </select>
        </label>
        <p>
          <span>
            Operator-supplied identifiers only; no prompts, secrets or environment values. Repeat
            the same safe task in each phase.
          </span>
        </p>
        <Button type="submit" size="sm" variant="outline" disabled={disabled}>
          <span>Save</span>
        </Button>
      </form>
    </details>
  );
}
