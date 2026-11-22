import * as Schema from "effect/Schema";

export const PrivacyRule = Schema.Struct({
  action: Schema.Literals(["block", "unblock", "clear"]),
  host: Schema.optional(Schema.String.check(Schema.isMaxLength(253))),
});
export type PrivacyRule = typeof PrivacyRule.Type;
export const PrivacyJournal = Schema.Struct({
  label: Schema.String,
  coverage: Schema.String,
  observed: Schema.Number,
  blocked: Schema.Array(Schema.String),
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
  { reason: Schema.Literals(["unavailable", "invalid_rule"]) },
) {
  override get message() {
    return this.reason === "invalid_rule"
      ? "Use an exact hostname for the block rule."
      : "The privacy observer is unavailable. Check its connection file and restart the observer on this machine.";
  }
}
