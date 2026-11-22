import { PrivacyJournal, PrivacyObserverError, type PrivacyRule } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

const Connection = Schema.Struct({
  port: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 65535 })),
  token: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(256)),
});
const decodeConnection = Schema.decodeUnknownEffect(Schema.fromJsonString(Connection));
const decodeJournal = Schema.decodeUnknownEffect(Schema.fromJsonString(PrivacyJournal));

export class PrivacyObserver extends Context.Service<
  PrivacyObserver,
  {
    readonly snapshot: () => Effect.Effect<PrivacyJournal | null, PrivacyObserverError>;
    readonly change: (input: PrivacyRule) => Effect.Effect<void, PrivacyObserverError>;
  }
>()("t3/privacy/PrivacyObserver") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const client = yield* HttpClient.HttpClient;
  const connectionFile = yield* Config.String("T3CODE_PRIVACY_OBSERVER_FILE").pipe(
    Config.withDefault(""),
  );
  const connection = Effect.fn("PrivacyObserver.connection")(function* () {
    if (!connectionFile) return yield* new PrivacyObserverError({ reason: "unavailable" });
    const text = yield* fileSystem.readFileString(connectionFile);
    if (text.length > 4096) return yield* new PrivacyObserverError({ reason: "unavailable" });
    return yield* decodeConnection(text);
  });
  const request = Effect.fn("PrivacyObserver.request")(
    function* (rule: PrivacyRule | undefined) {
      const config = yield* connection();
      // Only a port is configurable: neither clients nor the descriptor can redirect credentials.
      const url = `http://127.0.0.1:${config.port}/api/${rule ? "rules" : "events"}`;
      const base = rule ? HttpClientRequest.post(url) : HttpClientRequest.get(url);
      const authenticated = base.pipe(HttpClientRequest.bearerToken(Redacted.make(config.token)));
      const req = rule ? yield* HttpClientRequest.bodyJson(authenticated, rule) : authenticated;
      const response = yield* client
        .execute(req)
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      return yield* response.text;
    },
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.timeout("5 seconds"),
    Effect.mapError(() => new PrivacyObserverError({ reason: "unavailable" })),
  );

  return PrivacyObserver.of({
    snapshot: Effect.fn("PrivacyObserver.snapshot")(function* () {
      if (!connectionFile) return null;
      const body = yield* request(undefined);
      return yield* decodeJournal(body).pipe(
        Effect.mapError(() => new PrivacyObserverError({ reason: "unavailable" })),
      );
    }),
    change: Effect.fn("PrivacyObserver.change")(function* (input) {
      if (input.action !== "clear" && (!input.host || !/^[A-Za-z0-9.-]{1,253}$/.test(input.host))) {
        return yield* new PrivacyObserverError({ reason: "invalid_rule" });
      }
      yield* request(input);
    }),
  });
});
export const layer = Layer.effect(PrivacyObserver, make).pipe(Layer.provide(FetchHttpClient.layer));
