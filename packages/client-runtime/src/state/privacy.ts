import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createPrivacyAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  return {
    activity: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "privacy:activity",
      tag: WS_METHODS.privacyActivity,
    }),
    activityChange: createEnvironmentRpcCommand(runtime, {
      label: "privacy:activityChange",
      tag: WS_METHODS.privacyActivityChange,
    }),
    controls: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "privacy:controls",
      tag: WS_METHODS.privacyControls,
    }),
    providerChange: createEnvironmentRpcCommand(runtime, {
      label: "privacy:providerChange",
      tag: WS_METHODS.privacyProviderChange,
    }),
    sources: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "privacy:sources",
      tag: WS_METHODS.privacySources,
    }),
    snapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "privacy:snapshot",
      tag: WS_METHODS.privacySnapshot,
    }),
    change: createEnvironmentRpcCommand(runtime, {
      label: "privacy:change",
      tag: WS_METHODS.privacyChange,
    }),
  };
}
