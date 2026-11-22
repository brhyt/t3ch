import { it, expect } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Observer from "./PrivacyObserver.ts";

const journal = { label: "fixture", coverage: "routed only", observed: 0, blocked: [], events: [] };
it.effect("keeps the observer optional and validates rules without a connection", () =>
  Effect.gen(function* () {
    const observer = yield* Observer.PrivacyObserver;
    expect(yield* observer.snapshot()).toBeNull();
    expect(
      (yield* observer.change({ action: "block", host: "https://example.com" }).pipe(Effect.flip))
        .reason,
    ).toBe("invalid_rule");
    for (const input of [
      { action: "save-policy" as const, host: "a..test" },
      { action: "start-experiment" as const, host: "a.test" },
      { action: "start-experiment" as const, host: "a.test", durationSeconds: 3601 },
      { action: "finish-experiment" as const },
    ]) {
      expect((yield* observer.change(input).pipe(Effect.flip)).reason).toBe("invalid_rule");
    }
    expect((yield* observer.change({ action: "clear" }).pipe(Effect.flip)).reason).toBe(
      "unavailable",
    );
  }).pipe(
    Effect.provide(
      Observer.layer.pipe(
        Layer.provide(NodeServices.layer),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      ),
    ),
  ),
);

it.effect(
  "keeps credentials on loopback, reloads rotated descriptors and excludes extra response fields",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const path = `${directory}/observer.json`;
      const token = "a".repeat(32);
      yield* fs.writeFileString(
        path,
        JSON.stringify({ port: 8898, token, url: "https://untrusted.invalid" }),
      );
      const calls: {
        url: string;
        authorization: string | null;
        body: unknown;
        redirect: string | undefined;
      }[] = [];
      const observer = yield* Observer.PrivacyObserver.pipe(
        Effect.provide(
          Observer.layer.pipe(
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({ T3CODE_PRIVACY_OBSERVER_FILE: path }),
              ),
            ),
          ),
        ),
        Effect.provideService(FetchHttpClient.Fetch, async (url, init) => {
          calls.push({
            url: String(url),
            authorization: new Headers(init?.headers).get("authorization"),
            body: init?.body,
            redirect: init?.redirect,
          });
          return Response.json({ ...journal, token: "must-not-reach-client", body: "private" });
        }),
      );
      expect(yield* observer.snapshot()).toEqual(journal);
      yield* fs.writeFileString(path, JSON.stringify({ port: 8897, token: "b".repeat(32) }));
      yield* observer.change({ action: "block", host: "example.com" });
      expect(calls).toEqual([
        {
          url: "http://127.0.0.1:8898/api/events",
          authorization: `Bearer ${token}`,
          body: undefined,
          redirect: "error",
        },
        {
          url: "http://127.0.0.1:8897/api/rules",
          authorization: `Bearer ${"b".repeat(32)}`,
          body: expect.anything(),
          redirect: "error",
        },
      ]);
      yield* fs.writeFileString(path, '{"port":0,"token":"short"}');
      expect((yield* observer.snapshot().pipe(Effect.flip)).reason).toBe("unavailable");
      expect(calls).toHaveLength(2);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("returns a safe error when the observer fails", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const path = `${directory}/observer.json`;
    yield* fs.writeFileString(path, JSON.stringify({ port: 8898, token: "a".repeat(32) }));
    const observer = yield* Observer.PrivacyObserver.pipe(
      Effect.provide(
        Observer.layer.pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ T3CODE_PRIVACY_OBSERVER_FILE: path }),
            ),
          ),
        ),
      ),
      Effect.provideService(
        FetchHttpClient.Fetch,
        async () => new Response("private upstream output", { status: 500 }),
      ),
    );
    const error = yield* observer.snapshot().pipe(Effect.flip);
    expect(error.reason).toBe("unavailable");
    expect(JSON.stringify(error)).not.toContain("private upstream output");
  }).pipe(Effect.provide(NodeServices.layer)),
);
