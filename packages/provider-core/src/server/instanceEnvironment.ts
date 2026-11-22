import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { expandHomePath } from "./pathExpansion.ts";

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  const host = yield* HostProcess.Environment;
  const hostAllowlist = host.T3CODE_PROVIDER_ENV_ALLOWLIST ?? baseEnv.T3CODE_PROVIDER_ENV_ALLOWLIST;
  const instanceAllowlist = environment?.find(
    (variable) => variable.name.toUpperCase() === "T3CODE_PROVIDER_ENV_ALLOWLIST",
  )?.value;
  const allowlists = [
    hostAllowlist,
    typeof instanceAllowlist === "string" ? instanceAllowlist : undefined,
  ].filter((value) => value !== undefined);
  if (allowlists.length > 0) {
    const platform = yield* HostProcess.Platform;
    const canonical = (name: string) => (platform === "win32" ? name.toUpperCase() : name);
    const allowed = allowlists.map(
      (list) => new Set(list.split(",").map((name) => canonical(name.trim()))),
    );
    // Undefined entries remove inherited values even in launchers that extend process.env.
    baseEnv = Object.fromEntries(
      Object.keys({ ...host, ...baseEnv }).map((name) => [
        name,
        allowed.every((list) => list.has(canonical(name))) ? baseEnv[name] : undefined,
      ]),
    );
  }
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const home = yield* HostProcess.HomeDirectory;
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    // Child processes do not apply shell expansion to environment values.
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value, home)
        : variable.value;
  }
  return next;
});
