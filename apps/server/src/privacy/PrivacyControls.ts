import { ServerSettingsError } from "@t3tools/contracts";
import * as CloudLink from "../cloud/CloudLink.ts";
import {
  PRIVACY_PROVIDER_BASE_ENVIRONMENT,
  PrivacyObserverError,
  type PrivacyControlsSnapshot,
  type PrivacyProviderChange,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";

const allowlistName = "T3CODE_PROVIDER_ENV_ALLOWLIST";
const names = (value: string | undefined) =>
  value === undefined
    ? null
    : value
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
const destination = (value: string | undefined) => {
  if (!value) return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
};

export class PrivacyControls extends Context.Service<
  PrivacyControls,
  {
    readonly activity: () => Effect.Effect<boolean | null, PrivacyObserverError>;
    readonly changeActivity: (enabled: boolean) => Effect.Effect<void, PrivacyObserverError>;
    readonly snapshot: () => Effect.Effect<PrivacyControlsSnapshot, PrivacyObserverError>;
    readonly changeProvider: (
      input: PrivacyProviderChange,
    ) => Effect.Effect<void, PrivacyObserverError>;
  }
>()("t3/privacy/PrivacyControls") {}

const make = Effect.gen(function* () {
  const cloudLink = yield* CloudLink.CloudLink;
  const settings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const host = yield* HostProcess.Environment;
  const windows = (yield* HostProcess.Platform) === "win32";
  const canonical = (name: string) => (windows ? name.toUpperCase() : name);
  const telemetry = yield* Config.Boolean("T3CODE_TELEMETRY_ENABLED").pipe(
    Config.withDefault(false),
  );
  const relayTracing =
    telemetry &&
    !["true", "1", "yes", "on", "y"].includes(
      (host.T3CODE_OTEL_SDK_DISABLED ?? host.OTEL_SDK_DISABLED ?? "false").toLowerCase(),
    );
  return PrivacyControls.of({
    activity: Effect.fn("PrivacyControls.activity")(function* () {
      return (yield* cloudLink
        .linkState()
        .pipe(Effect.mapError(() => new PrivacyObserverError({ reason: "unavailable" }))))
        .publishAgentActivity;
    }),
    changeActivity: Effect.fn("PrivacyControls.changeActivity")(function* (enabled) {
      yield* cloudLink
        .updatePreferences({ publishAgentActivity: enabled })
        .pipe(Effect.mapError(() => new PrivacyObserverError({ reason: "unavailable" })));
    }),
    snapshot: Effect.fn("PrivacyControls.snapshot")(function* () {
      const saved = yield* settings.getSettings.pipe(
        Effect.mapError(() => new PrivacyObserverError({ reason: "unavailable" })),
      );
      return {
        serverTelemetry: telemetry ? "on" : "off",
        serverRelayTracing: relayTracing ? "on" : "off",
        hostAllowlist: names(host[allowlistName]),
        customDiagnostics: [
          {
            signal: "traces",
            enabled: config.otlpTracesUrl !== undefined,
            source: "startup",
            destination: destination(config.otlpTracesUrl),
            savedEnabled: Boolean(saved.observability.otlpTracesUrl),
          },
          {
            signal: "metrics",
            enabled: config.otlpMetricsUrl !== undefined,
            source: "startup",
            destination: destination(config.otlpMetricsUrl),
            savedEnabled: Boolean(saved.observability.otlpMetricsUrl),
          },
          {
            signal: "logs",
            enabled: config.otlpLogsUrl !== undefined,
            source: "startup",
            destination: destination(config.otlpLogsUrl),
            savedEnabled: Boolean(saved.observability.otlpLogsUrl),
          },
        ],
        providers: yield* Effect.forEach(
          Object.entries(deriveProviderInstanceConfigMap(saved)),
          Effect.fn("PrivacyControls.providerStatus")(function* ([id, instance]) {
            const effectiveEnvironment = yield* mergeProviderInstanceEnvironment(
              instance.environment,
              host,
            );
            const get = (name: string) => {
              const value = instance.environment?.find(
                (entry) => canonical(entry.name) === canonical(name),
              )?.value;
              return typeof value === "string" ? value : undefined;
            };
            const list = names(get(allowlistName));
            const unresolvedTelemetry =
              instance.environment?.some(
                (entry) =>
                  canonical(entry.name) === "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" &&
                  typeof entry.value !== "string",
              ) ?? false;
            const claude = effectiveEnvironment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? "1";
            return {
              id: id as PrivacyControlsSnapshot["providers"][number]["id"],
              name: instance.displayName ?? id,
              driver: instance.driver,
              inheritedEnvironment:
                list !== null || host[allowlistName] !== undefined
                  ? ("restricted" as const)
                  : ("unrestricted" as const),
              instanceAllowlist: list,
              explicitVariableCount:
                instance.environment?.filter((entry) => entry.name !== allowlistName).length ?? 0,
              telemetry:
                instance.driver === "claudeAgent"
                  ? !unresolvedTelemetry && claude === "1"
                    ? ("off" as const)
                    : ("unknown" as const)
                  : ("unknown" as const),
              telemetryControl:
                instance.driver === "claudeAgent"
                  ? ("claude" as const)
                  : instance.driver === "codex"
                    ? ("launch-arguments" as const)
                    : ("provider-owned" as const),
              proxyConfigured: Boolean(
                effectiveEnvironment.HTTPS_PROXY ?? effectiveEnvironment.https_proxy,
              ),
            };
          }),
        ),
      };
    }),
    changeProvider: Effect.fn("PrivacyControls.changeProvider")(function* (input) {
      const saved = yield* settings.getSettings.pipe(
        Effect.mapError(() => new PrivacyObserverError({ reason: "unavailable" })),
      );
      const instance = deriveProviderInstanceConfigMap(saved)[input.instanceId];
      if (!instance || (input.action === "claude-telemetry" && instance.driver !== "claudeAgent"))
        return yield* new PrivacyObserverError({ reason: "invalid_control" });
      const name =
        input.action === "inheritance" ? allowlistName : "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC";
      const value =
        input.action === "inheritance"
          ? input.restricted
            ? PRIVACY_PROVIDER_BASE_ENVIRONMENT.join(",")
            : undefined
          : input.enabled
            ? "0"
            : "1";
      yield* settings
        .updateProviderInstance((current) =>
          Effect.gen(function* () {
            const latest = deriveProviderInstanceConfigMap(current)[input.instanceId];
            if (!latest || latest.driver !== instance.driver)
              return yield* new ServerSettingsError({
                settingsPath: "<privacy>",
                operation: "write-file",
              });
            const environment = (latest.environment ?? []).filter(
              (entry) => canonical(entry.name) !== canonical(name),
            );
            return {
              operation: "upsert" as const,
              instanceId: input.instanceId,
              instance: {
                ...latest,
                environment:
                  value === undefined
                    ? environment
                    : [...environment, { name, value, sensitive: false }],
              },
            };
          }),
        )
        .pipe(Effect.mapError(() => new PrivacyObserverError({ reason: "unavailable" })));
    }),
  });
});
export const layer = Layer.effect(PrivacyControls, make);
