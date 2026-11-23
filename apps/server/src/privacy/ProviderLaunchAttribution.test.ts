// @effect-diagnostics nodeBuiltinImport:off -- Disposable FIFO validates nonblocking optional attribution before provider startup.
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Attribution from "./ProviderLaunchAttribution.ts";

it.effect("annotates only selected observer routes and revokes each scoped launch", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const folder = yield* fs.makeTempDirectoryScoped();
    const descriptor = `${folder}/observer.json`;
    yield* fs.writeFileString(
      descriptor,
      JSON.stringify({ port: 12345, proxyPort: 12346, token: "a".repeat(32) }),
    );
    const actions: unknown[] = [];
    let registrations = 0;
    const service = yield* Attribution.ProviderLaunchAttribution.pipe(
      Effect.provide(
        Attribution.layer.pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ T3CODE_PRIVACY_OBSERVER_FILE: descriptor }),
            ),
          ),
        ),
      ),
      Effect.provideService(FetchHttpClient.Fetch, async (url, init) => {
        expect(String(url)).toBe("http://127.0.0.1:12345/api/launches");
        expect(init?.redirect).toBe("error");
        const body = JSON.parse(String(init?.body));
        actions.push(body);
        if (body.action === "register") registrations++;
        return Response.json(
          body.action === "register"
            ? {
                credential: String(registrations).repeat(32),
                launchId: String(registrations).repeat(32),
              }
            : { ok: true },
        );
      }),
    );
    const context = { providerInstanceId: "codex-fixture", initiatingThreadId: "thread-fixture" };
    expect(yield* service.route({ HTTPS_PROXY: "http://unrelated.test:80" }, context)).toEqual({
      HTTPS_PROXY: "http://unrelated.test:80",
    });
    expect(actions).toEqual([]);
    const routed = yield* Effect.scoped(
      service.route(
        { HTTP_PROXY: "http://127.0.0.1:12346", HTTPS_PROXY: "http://unrelated.test:80" },
        context,
      ),
    );
    expect(routed.HTTP_PROXY).toBe(`http://t3-launch:${"1".repeat(32)}@127.0.0.1:12346`);
    expect(routed.HTTPS_PROXY).toBe("http://unrelated.test:80");
    const second = yield* Effect.scoped(
      service.route({ ALL_PROXY: "http://127.0.0.1:12346/" }, context),
    );
    expect(second.ALL_PROXY).toContain("2".repeat(32));
    expect(actions).toEqual([
      { action: "register", ...context },
      { action: "revoke", launchId: "1".repeat(32) },
      { action: "register", ...context },
      { action: "revoke", launchId: "2".repeat(32) },
    ]);
    yield* fs.remove(descriptor);
    const original = { HTTPS_PROXY: "http://127.0.0.1:12346" };
    expect(yield* service.route(original, context)).toEqual(original);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("keeps startup available for oversized and non-regular descriptors", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const folder = yield* fs.makeTempDirectoryScoped();
    const descriptor = `${folder}/observer.json`;
    const service = yield* Attribution.ProviderLaunchAttribution.pipe(
      Effect.provide(
        Attribution.layer.pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ T3CODE_PRIVACY_OBSERVER_FILE: descriptor }),
            ),
          ),
        ),
      ),
    );
    const original = { HTTPS_PROXY: "http://127.0.0.1:12346" };
    const context = { providerInstanceId: "fixture", initiatingThreadId: "fixture" };
    yield* fs.writeFileString(descriptor, "x".repeat(4097));
    expect(yield* service.route(original, context)).toEqual(original);
    yield* fs.remove(descriptor);
    if ((yield* HostProcess.Platform) !== "win32") {
      NodeChildProcess.execFileSync("mkfifo", [descriptor]);
      try {
        expect(yield* service.route(original, context)).toEqual(original);
      } finally {
        // Release any blocked reader if this regression fails, so the test process can exit.
        const writer = NodeFS.openSync(
          descriptor,
          NodeFS.constants.O_RDWR | NodeFS.constants.O_NONBLOCK,
        );
        NodeFS.closeSync(writer);
      }
    } else {
      yield* fs.makeDirectory(descriptor);
      expect(yield* service.route(original, context)).toEqual(original);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
