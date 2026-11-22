import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";

export const PrivacyRule = Schema.Struct({
  action: Schema.Literals([
    "block",
    "save-policy",
    "remove-policy",
    "start-experiment",
    "stop-experiment",
    "finish-experiment",
    "unblock",
    "clear",
    "review-finding",
    "reopen-finding",
    "clear-findings",
  ]),
  durationSeconds: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 3600 })),
  ),
  experimentId: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/))),
  findingId: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  host: Schema.optional(Schema.String.check(Schema.isMaxLength(253))),
});
export type PrivacyRule = typeof PrivacyRule.Type;
const PrivacyCounters = Schema.Struct({
  observed: Schema.Number,
  blocked: Schema.Number,
  responses: Schema.Number,
  errors: Schema.Number,
});
export const PrivacyJournal = Schema.Struct({
  policyStorage: Schema.optional(
    Schema.Struct({
      status: Schema.Literals(["ready", "ephemeral", "unavailable"]),
      persistenceError: Schema.Boolean,
    }),
  ),
  attribution: Schema.optional(
    Schema.Struct({
      kind: Schema.Literal("operator-supplied"),
      source: Schema.String,
      impactScope: Schema.Literal("shared-proxy-unknown"),
    }),
  ),
  rules: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        host: Schema.String,
        kind: Schema.Literals(["session", "saved", "temporary"]),
        createdAt: Schema.Number,
        expiresAt: Schema.NullOr(Schema.Number),
      }),
    ),
  ),
  experiments: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        host: Schema.String,
        startedAt: Schema.Number,
        expiresAt: Schema.Number,
        recoveryAt: Schema.NullOr(Schema.Number),
        finishedAt: Schema.NullOr(Schema.Number),
        phase: Schema.Literals(["blocked", "recovery", "finished"]),
        baselineStartedAt: Schema.NullOr(Schema.Number),
        baselineEndedAt: Schema.Number,
        evidenceIncomplete: Schema.Boolean,
        baseline: PrivacyCounters,
        blocked: PrivacyCounters,
        recovery: PrivacyCounters,
        outcome: Schema.Literal("unknown"),
        evidence: Schema.Literal("bounded-proxy-observations"),
      }),
    ),
  ),
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
