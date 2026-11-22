import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";

export const PrivacyRule = Schema.Struct({
  action: Schema.Literals([
    "block",
    "unblock",
    "clear",
    "review-finding",
    "reopen-finding",
    "clear-findings",
  ]),
  findingId: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  host: Schema.optional(Schema.String.check(Schema.isMaxLength(253))),
});
export type PrivacyRule = typeof PrivacyRule.Type;
export const PrivacyJournal = Schema.Struct({
  label: Schema.String,
  coverage: Schema.String,
  observed: Schema.Number,
  blocked: Schema.Array(Schema.String),
  tracking: Schema.optional(
    Schema.Struct({
      sessionStartedAt: Schema.Number,
      lastObservedAt: Schema.NullOr(Schema.Number),
      observedThisSession: Schema.Number,
      directTraffic: Schema.Literal("unknown"),
      retentionDays: Schema.Number,
      persistent: Schema.Boolean,
      persistenceError: Schema.Boolean,
    }),
  ),
  issues: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        source: Schema.String,
        host: Schema.String,
        kind: Schema.String,
        location: Schema.String,
        firstSeen: Schema.Number,
        lastSeen: Schema.Number,
        occurrences: Schema.Number,
        blocked: Schema.Number,
        state: Schema.Literals(["open", "reviewed"]),
        reviewedAt: Schema.NullOr(Schema.Number),
        lastOutcome: Schema.String,
      }),
    ),
  ),
  events: Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      time: Schema.Number,
      source: Schema.String,
      host: Schema.String,
      method: Schema.String,
      status: Schema.String,
      category: Schema.String,
      fields: Schema.Array(Schema.String),
      bodyBytes: Schema.Number,
      scanTruncated: Schema.Boolean,
      inspection: Schema.String,
      findings: Schema.Array(
        Schema.Struct({
          kind: Schema.String,
          location: Schema.String,
          count: Schema.Number,
          expected: Schema.Boolean,
        }),
      ),
    }),
  ),
});
export type PrivacyJournal = typeof PrivacyJournal.Type;
export const PrivacySnapshot = Schema.NullOr(PrivacyJournal);
export class PrivacyObserverError extends Schema.TaggedError<PrivacyObserverError>()(
  "PrivacyObserverError",
  { reason: Schema.Literals(["unavailable", "invalid_rule", "invalid_control"]) },
) {
  override get message() {
    if (this.reason === "invalid_control")
      return "This privacy control is not supported for the selected provider.";
    return this.reason === "invalid_rule"
      ? "Use an exact hostname for the block rule."
      : "The privacy observer is unavailable. Check its connection file and restart the observer on this machine.";
  }
}

export const PrivacyControlState = Schema.Literals(["off", "on", "unknown"]);
export const PrivacyControlsSnapshot = Schema.Struct({
  serverTelemetry: PrivacyControlState,
  serverRelayTracing: PrivacyControlState,
  customDiagnostics: Schema.Array(
    Schema.Struct({
      signal: Schema.Literals(["traces", "metrics", "logs"]),
      enabled: Schema.Boolean,
      source: Schema.String,
      destination: Schema.NullOr(Schema.String),
      savedEnabled: Schema.Boolean,
    }),
  ),
  hostAllowlist: Schema.NullOr(Schema.Array(Schema.String)),
  providers: Schema.Array(
    Schema.Struct({
      id: ProviderInstanceId,
      name: Schema.String,
      driver: Schema.String,
      inheritedEnvironment: Schema.Literals(["restricted", "unrestricted"]),
      instanceAllowlist: Schema.NullOr(Schema.Array(Schema.String)),
      explicitVariableCount: Schema.Number,
      telemetry: PrivacyControlState,
      telemetryControl: Schema.Literals(["claude", "launch-arguments", "provider-owned"]),
      proxyConfigured: Schema.Boolean,
    }),
  ),
});
export type PrivacyControlsSnapshot = typeof PrivacyControlsSnapshot.Type;
export const PrivacyProviderChange = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("inheritance"),
    instanceId: ProviderInstanceId,
    restricted: Schema.Boolean,
  }),
  Schema.Struct({
    action: Schema.Literal("claude-telemetry"),
    instanceId: ProviderInstanceId,
    enabled: Schema.Boolean,
  }),
]);
export type PrivacyProviderChange = typeof PrivacyProviderChange.Type;
export const PRIVACY_PROVIDER_BASE_ENVIRONMENT = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_USE_ENV_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
] as const;
