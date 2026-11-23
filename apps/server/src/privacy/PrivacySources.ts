// @effect-diagnostics nodeBuiltinImport:off -- Bounded nonblocking descriptor reads and direct HTTP prevent FIFO hangs, proxy forwarding and redirects.
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import {
  PrivacyJournal,
  PrivacyObserverError,
  PrivacyRule,
  PrivacySourceId,
  PrivacyHop,
  PrivacySourceError,
  PrivacySourceSnapshot,
  PrivacySourcesSnapshot,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Observer from "./PrivacyObserver.ts";
import { readObserverDescriptor } from "./ObserverDescriptor.ts";

const hops = [
  "capture",
  "memory-delivery",
  "downstream-inference",
  "delegation",
  "artifacts",
] as const;
const SourceConfig = Schema.Struct({
  id: PrivacySourceId,
  descriptorFile: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  configuredHops: Schema.optional(Schema.Array(PrivacyHop).check(Schema.isMaxLength(5))),
});
const ExtraSources = Schema.Array(SourceConfig).check(Schema.isMaxLength(7));
const Connection = Schema.Struct({
  port: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 65535 })),
  token: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._~-]{32,256}$/)),
});
const decodeConnection = Schema.decodeSync(Schema.fromJsonString(Connection));
const decodeJournal = Schema.decodeSync(Schema.fromJsonString(PrivacyJournal));
const decodeExtras = Schema.decodeSync(Schema.fromJsonString(ExtraSources));
const isSourceId = Schema.is(PrivacySourceId);
export class PrivacySources extends Context.Service<
  PrivacySources,
  {
    readonly snapshots: () => Effect.Effect<typeof PrivacySourcesSnapshot.Type>;
    readonly snapshot: (
      sourceId?: string,
    ) => Effect.Effect<PrivacySourceSnapshot, PrivacySourceError>;
    readonly change: (
      sourceId: string,
      input: PrivacyRule,
    ) => Effect.Effect<void, PrivacySourceError | PrivacyObserverError>;
  }
>()("t3/privacy/PrivacySources") {}

// node:http connects directly to a literal loopback address, bypassing ambient proxy settings.
// It never follows redirects. Neither the response nor a descriptor can choose another endpoint.
function readJournal(port: number, token: string, signal: AbortSignal): Promise<PrivacyJournal> {
  return new Promise((resolve, reject) => {
    const request = NodeHttp.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/events",
        agent: false,
        headers: { authorization: `Bearer ${token}` },
        signal,
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.destroy();
          reject(new Error("response"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) {
            response.destroy(new Error("capacity"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            resolve(decodeJournal(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("journal"));
          }
        });
      },
    );
    request.on("error", reject);
  });
}

function parseExtras(rawExtras: string, primary: string) {
  let configuration: "valid" | "invalid-extras" = "valid";
  let extras: typeof ExtraSources.Type = [];
  try {
    if (Buffer.byteLength(rawExtras) > 32768) throw new Error("configuration");
    extras = decodeExtras(rawExtras);
    const ids = new Set(["primary"]);
    const paths = new Set([primary]);
    for (const extra of extras) {
      if (
        !NodePath.isAbsolute(extra.descriptorFile) ||
        ids.has(extra.id) ||
        paths.has(extra.descriptorFile)
      )
        throw new Error("configuration");
      ids.add(extra.id);
      paths.add(extra.descriptorFile);
    }
  } catch {
    extras = [];
    configuration = "invalid-extras";
  }
  return { configuration, extras };
}

const make = Effect.gen(function* () {
  const primary = yield* Config.String("T3CODE_PRIVACY_OBSERVER_FILE").pipe(Config.withDefault(""));
  const rawExtras = yield* Config.String("T3CODE_PRIVACY_OBSERVER_SOURCES").pipe(
    Config.withDefault("[]"),
  );
  const observer = yield* Observer.PrivacyObserver;
  const { configuration, extras } = parseExtras(rawExtras, primary);
  const sources = [{ id: "primary", descriptorFile: primary, configuredHops: [] }, ...extras];
  const snapshot = Effect.fn("PrivacySources.snapshot")(function* (sourceId = "primary") {
    const source = isSourceId(sourceId) ? sources.find((item) => item.id === sourceId) : undefined;
    if (!source) return yield* new PrivacySourceError({ reason: "unknown_source" });
    const journal = source.descriptorFile
      ? yield* Effect.tryPromise({
          try: async (signal) => {
            const connection = decodeConnection(
              await readObserverDescriptor(source.descriptorFile),
            );
            return readJournal(connection.port, connection.token, signal);
          },
          // No causes, descriptor paths, tokens or response text escape into logs or RPC errors.
          catch: () => new PrivacyObserverError({ reason: "unavailable" }),
        }).pipe(
          Effect.timeout("5 seconds"),
          Effect.orElseSucceed(() => null),
        )
      : null;
    const fetchedAt = (yield* Clock.currentTimeMillis) / 1000;
    const generatedAt = journal?.generatedAt;
    const freshness =
      generatedAt === undefined || !Number.isFinite(generatedAt) || generatedAt > fetchedAt + 5
        ? "unknown"
        : fetchedAt - generatedAt > 60
          ? "stale"
          : "fresh";
    return {
      id: source.id,
      identity: "operator-configured-source",
      permissions: { read: true, change: source.id === "primary" },
      status: !source.descriptorFile ? "not-configured" : journal ? "available" : "unavailable",
      fetchedAt,
      freshness,
      journal,
      // A journal proves proxy traffic, not which managed flow produced it. Require future correlation instrumentation.
      hops: hops.map((hop) => ({
        hop,
        configured: source.configuredHops?.includes(hop) ?? false,
        evidence: "unverified" as const,
      })),
    } satisfies PrivacySourceSnapshot;
  });
  return PrivacySources.of({
    snapshot,
    snapshots: Effect.fn("PrivacySources.snapshots")(function* () {
      const results = yield* Effect.forEach(sources, (source) => snapshot(source.id), {
        concurrency: 8,
      });
      return { configuration, sources: results };
    }, Effect.orDie),
    change: Effect.fn("PrivacySources.change")(function* (sourceId, input) {
      if (!isSourceId(sourceId) || !sources.some((source) => source.id === sourceId))
        return yield* new PrivacySourceError({ reason: "unknown_source" });
      if (sourceId !== "primary") return yield* new PrivacySourceError({ reason: "read_only" });
      yield* observer.change(input);
    }),
  });
});
export const layer = Layer.effect(PrivacySources, make);
