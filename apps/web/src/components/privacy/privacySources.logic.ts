import { PrivacySourcesSnapshot } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isCatalog = Schema.is(PrivacySourcesSnapshot);
export function readSourceCatalog(value: unknown) {
  if (!isCatalog(value)) return null;
  const ids = value.sources.map((source) => source.id);
  if (!ids.includes("primary") || new Set(ids).size !== ids.length) return null;
  return value;
}

export function mayChangeSource(caller: boolean, id: string, permission: boolean) {
  return caller && id === "primary" && permission;
}
