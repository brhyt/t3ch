import { PrivacyObserverError } from "@t3tools/contracts";
import { readObserverDescriptor } from "./ObserverDescriptor.ts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

const Port = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 65535 }));
const Connection = Schema.Struct({
  port: Port,
  proxyPort: Port,
  token: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(256)),
});
const Lease = Schema.Struct({
  credential: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{32,128}$/)),
  launchId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
});
const decodeConnection = Schema.decodeEffect(Schema.fromJsonString(Connection));
const decodeLease = Schema.decodeUnknownEffect(Lease);
const proxyKeys = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

export class ProviderLaunchAttribution extends Context.Service<
  ProviderLaunchAttribution,
  {
    readonly route: (
      environment: NodeJS.ProcessEnv,
      context: { providerInstanceId: string; initiatingThreadId: string },
    ) => Effect.Effect<NodeJS.ProcessEnv, never, Scope.Scope>;
  }
>()("t3/privacy/ProviderLaunchAttribution") {}

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const descriptor = yield* Config.String("T3CODE_PRIVACY_OBSERVER_FILE").pipe(
    Config.withDefault(""),
    Effect.orElseSucceed(() => ""),
  );
  return ProviderLaunchAttribution.of({
    route: Effect.fn("ProviderLaunchAttribution.route")(function* (environment, context) {
      if (!descriptor) return environment;
      return yield* Effect.gen(function* () {
        const text = yield* Effect.tryPromise({
          try: () => readObserverDescriptor(descriptor),
          catch: () => new PrivacyObserverError({ reason: "unavailable" }),
        });
        const config = yield* decodeConnection(text);
        const route = `http://127.0.0.1:${config.proxyPort}`;
        // Only annotate routes already selected by the operator. Preserve unrelated proxies.
        const keys = proxyKeys.filter(
          (key) => environment[key] === route || environment[key] === `${route}/`,
        );
        if (keys.length === 0) return environment;
        const request = Effect.fn("ProviderLaunchAttribution.request")(function* (body: object) {
          const req = yield* HttpClientRequest.post(
            `http://127.0.0.1:${config.port}/api/launches`,
          ).pipe(
            HttpClientRequest.bearerToken(Redacted.make(config.token)),
            HttpClientRequest.bodyJson(body),
          );
          const response = yield* client.execute(req);
          yield* HttpClientResponse.filterStatusOk(response);
          return yield* response.json;
        }, Effect.timeout("1 second"));
        const lease = yield* Effect.acquireRelease(
          request({ action: "register", ...context }).pipe(Effect.flatMap(decodeLease)),
          (lease) => request({ action: "revoke", launchId: lease.launchId }).pipe(Effect.ignore),
        );
        const result = { ...environment };
        for (const key of keys)
          result[key] = `http://t3-launch:${lease.credential}@127.0.0.1:${config.proxyPort}`;
        return result;
      }).pipe(
        Effect.timeout("1 second"),
        Effect.orElseSucceed(() => environment),
      );
    }),
  });
});
export const layer = Layer.effect(ProviderLaunchAttribution, make).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "error" })),
);
