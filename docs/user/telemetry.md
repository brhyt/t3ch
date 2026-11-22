# Product usage data

The T3 Code server sends product usage events to PostHog, associated with a hashed account or
installation identifier. Events include the provider, model, reasoning effort, permission mode,
turn result, duration, and main-agent token totals when available.

Events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output. Child-agent token use is excluded from the totals.

To disable collection, set `T3CODE_TELEMETRY_ENABLED=false` in the server's environment before
starting it. This stops product events from being recorded or sent.

The desktop app reads the variable from your shell profile (for example `~/.zshrc`) on macOS and
Linux, so export it there and restart the app. On Windows, set it as a user environment variable.

## Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver, open
**Settings > General > Diagnostics**, select an environment, and enter each signal's OTLP HTTP
endpoint under **OpenTelemetry export** (for example `http://localhost:4318/v1/traces`). Save, then
restart that environment's server. The receiver must be reachable from the server's machine.
**Test** sends an empty export from the server to check an endpoint before or after you save it;
saved endpoints are checked when the section opens. Checks send authentication headers only to
the signal's currently running endpoint and do not follow redirects. To check a new endpoint
that requires authentication, save it and restart the server first.

`T3CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` environment variables override the saved
settings. For endpoints saved here or set with `T3CODE_OTLP_*_URL`, set `T3CODE_OTLP_HEADERS` for
receivers that need authentication and `T3CODE_OTLP_PROTOCOL=http/protobuf` for receivers that do
not accept JSON. An endpoint set with `OTEL_EXPORTER_OTLP_*` takes its headers and protocol from
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_PROTOCOL` instead.

## Privacy controls in this fork

Product analytics and server relay tracing are off unless `T3CODE_TELEMETRY_ENABLED=true` is set before startup. Browser relay tracing also requires `VITE_T3CODE_TELEMETRY_ENABLED=true` at build time; mobile relay tracing requires `EXPO_PUBLIC_T3CODE_TELEMETRY_ENABLED=true` at build time. Configured collector URLs alone no longer enable these exports. Existing telemetry opt-outs and SDK disable flags still take precedence where supported. User-configured OpenTelemetry receivers are separate.

Claude launches default to `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`; an explicit provider environment value can override it. Codex app-server launches default to `-c analytics.enabled=false`; explicit launch arguments can override it. These switches do not disable conversation uploads or model-initiated requests. Other providers retain their own controls. Claude hostname safety checks remain enabled.

To observe destinations and masked sensitive-data findings before blocking anything, use the [local data activity dashboard](../../tools/privacy-observer/README.md). It must be started separately and sees only traffic routed through its proxy. No network restrictions are enabled by default.

To limit inherited provider environment variables, set `T3CODE_PROVIDER_ENV_ALLOWLIST` on the server to a comma-separated list of exact variable names, for example `PATH,HOME,USER,LANG,TERM`. An empty list inherits none. Explicit provider-instance values are still passed. Restart the server/providers afterward. Include required proxy and certificate variables when testing the observer. This controls environment inheritance, not filesystem access: agents can still read credentials in accessible files. Provider-native settings and subprocess startup scripts can supply additional variables.

The repository ignores `.claude/settings.local.json`. Run `node scripts/check-agent-secrets.mjs` before committing to check staged agent configuration; CI checks tracked configuration too. It rejects local permission history and common literal credential patterns, without printing matched values. Use environment-variable or secret-provider references in approved commands. This targeted check is not a complete secret scanner or a scan of Git history.

The sidebar shield opens the embedded **Privacy dashboard**. It is also available in the command palette and **Settings → General → Diagnostics**. Choose the observer’s machine and follow the [connection setup](../../tools/privacy-observer/README.md#open-inside-t3ch).
