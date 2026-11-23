import * as Schema from "effect/Schema";
import { PrivacyJournal } from "./privacy.ts";

export const PrivacySourceId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,47}$/));
export const PrivacyHop = Schema.Literals([
  "capture",
  "memory-delivery",
  "downstream-inference",
  "delegation",
  "artifacts",
]);
export const PrivacySourceSnapshot = Schema.Struct({
  id: PrivacySourceId,
  identity: Schema.Literal("operator-configured-source"),
  permissions: Schema.Struct({ read: Schema.Literal(true), change: Schema.Boolean }),
  status: Schema.Literals(["not-configured", "available", "unavailable"]),
  fetchedAt: Schema.Number,
  freshness: Schema.Literals(["fresh", "stale", "unknown"]),
  journal: Schema.NullOr(PrivacyJournal),
  hops: Schema.Array(
    Schema.Struct({
      hop: PrivacyHop,
      configured: Schema.Boolean,
      evidence: Schema.Literal("unverified"),
    }),
  ),
});
export type PrivacySourceSnapshot = typeof PrivacySourceSnapshot.Type;
export const PrivacySourcesSnapshot = Schema.Struct({
  configuration: Schema.Literals(["valid", "invalid-extras"]),
  sources: Schema.Array(PrivacySourceSnapshot),
});
export class PrivacySourceError extends Schema.TaggedError<PrivacySourceError>()(
  "PrivacySourceError",
  {
    reason: Schema.Literals(["unknown_source", "read_only"]),
  },
) {
  override get message() {
    return "The privacy source is unknown or read-only.";
  }
}
