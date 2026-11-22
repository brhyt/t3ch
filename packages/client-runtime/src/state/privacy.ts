import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createPrivacyAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  return {
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
