// @effect-diagnostics nodeBuiltinImport:off -- Real ephemeral loopback servers and private disposable files test the security boundary.
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Observer from "./PrivacyObserver.ts";
import * as Sources from "./PrivacySources.ts";

const token = "fixture-token-".repeat(4);
const journal = { label: "fixture", coverage: "routed only", observed: 3, blocked: [], events: [] };
async function fixture() {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "privacy-sources-"));
  const servers: NodeHttp.Server[] = [];
  const change = vi.fn(() => Effect.void);
  const descriptor = async (name: string, handler: NodeHttp.RequestListener) => {
    const server = NodeHttp.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture");
    const path = NodePath.join(directory, name);
    await NodeFSP.writeFile(
      path,
      JSON.stringify({ port: address.port, token, url: "https://untrusted.invalid" }),
    );
    return path;
  };
  const run = <A, E>(
    config: Record<string, string>,
    use: (service: Sources.PrivacySources["Service"]) => Effect.Effect<A, E>,
  ) =>
    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Async disposable native servers exercise the Promise HTTP boundary; timeout assertions use TestClock.
    Effect.runPromise(
      Effect.flatMap(Sources.PrivacySources, use).pipe(
        Effect.provide(
          Sources.layer.pipe(
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
            Layer.provide(
              Layer.succeed(
                Observer.PrivacyObserver,
                Observer.PrivacyObserver.of({ snapshot: () => Effect.succeed(null), change }),
              ),
            ),
          ),
        ),
      ),
    );
  return {
    directory,
    descriptor,
    run,
    change,
    async [Symbol.asyncDispose]() {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.closeAllConnections();
              server.close(() => resolve());
            }),
        ),
      );
      await NodeFSP.rm(directory, { recursive: true, force: true });
    },
  };
}

it("preserves independent source journals, windows and freshness despite a missing extra", async () => {
  await using f = await fixture();
  const primary = await f.descriptor("primary", (_req, res) =>
    res.end(
      JSON.stringify({
        ...journal,
        generatedAt: 1,
        observationWindow: {
          startedAt: 1,
          endedAt: 2,
          retainedEvents: 0,
          capacity: 100,
          truncated: false,
        },
      }),
    ),
  );
  const extra = await f.descriptor("extra", (_req, res) =>
    res.end(
      JSON.stringify({
        ...journal,
        observed: 9,
        observationWindow: {
          startedAt: 30,
          endedAt: 40,
          retainedEvents: 0,
          capacity: 100,
          truncated: false,
        },
        token,
        rawBody: "private",
      }),
    ),
  );
  const result = await f.run(
    {
      T3CODE_PRIVACY_OBSERVER_FILE: primary,
      T3CODE_PRIVACY_OBSERVER_SOURCES: JSON.stringify([
        { id: "honcho", descriptorFile: extra, configuredHops: ["downstream-inference"] },
        { id: "missing", descriptorFile: NodePath.join(f.directory, "missing") },
      ]),
    },
    (s) => s.snapshots(),
  );
  expect(result.configuration).toBe("valid");
  expect(result.sources.map((s) => [s.id, s.status, s.freshness, s.journal?.observed])).toEqual([
    ["primary", "available", "stale", 3],
    ["honcho", "available", "unknown", 9],
    ["missing", "unavailable", "unknown", undefined],
  ]);
  expect(result.sources.map((s) => s.journal?.observationWindow?.startedAt)).toEqual([
    1,
    30,
    undefined,
  ]);
  expect(result.sources[1]?.permissions.change).toBe(false);
  expect(result.sources[1]?.hops.find((h) => h.hop === "downstream-inference")).toEqual({
    hop: "downstream-inference",
    configured: true,
    evidence: "unverified",
  });
  expect(result.sources.flatMap((s) => s.hops).every((h) => h.evidence === "unverified")).toBe(
    true,
  );
  expect(JSON.stringify(result)).not.toContain(token);
  expect(JSON.stringify(result)).not.toContain("private");
  expect(JSON.stringify(result)).not.toContain(f.directory);
});

it("selects only registered IDs and refuses every extra mutation before IO", async () => {
  await using f = await fixture();
  const config = {
    T3CODE_PRIVACY_OBSERVER_SOURCES: JSON.stringify([
      { id: "honcho", descriptorFile: NodePath.join(f.directory, "absent") },
    ]),
  };
  for (const id of [
    "/tmp/file",
    "http://127.0.0.1:1",
    "primary?token=x",
    "unknown",
    "PRIMARY",
    "",
  ]) {
    expect(await f.run(config, (s) => s.snapshot(id).pipe(Effect.flip))).toMatchObject({
      reason: "unknown_source",
    });
    expect(
      await f.run(config, (s) => s.change(id, { action: "clear" }).pipe(Effect.flip)),
    ).toMatchObject({ reason: "unknown_source" });
  }
  expect(
    await f.run(config, (s) => s.change("honcho", { action: "clear" }).pipe(Effect.flip)),
  ).toMatchObject({ reason: "read_only" });
  expect(f.change).not.toHaveBeenCalled();
  await f.run(config, (s) => s.change("primary", { action: "clear" }));
  expect(f.change).toHaveBeenCalledOnce();
  expect(await f.run({}, (s) => s.snapshot())).toMatchObject({
    id: "primary",
    status: "not-configured",
    journal: null,
  });
});

it("never follows redirects or forwards credentials and reloads rotated descriptors", async () => {
  await using f = await fixture();
  const target = vi.fn<NodeHttp.RequestListener>((_req, res) => res.end(JSON.stringify(journal)));
  const targetFile = await f.descriptor("target", target);
  const targetConnection = JSON.parse(await NodeFSP.readFile(targetFile, "utf8")) as {
    port: number;
  };
  const requestSeen = vi.fn();
  const redirect = await f.descriptor("redirect", (req, res) => {
    requestSeen(req.url, req.headers.authorization);
    res.writeHead(302, { location: `http://127.0.0.1:${targetConnection.port}/leak` });
    res.end(token);
  });
  const config = { T3CODE_PRIVACY_OBSERVER_FILE: redirect };
  expect(await f.run(config, (s) => s.snapshot())).toMatchObject({ status: "unavailable" });
  expect(requestSeen).toHaveBeenCalledWith("/api/events", `Bearer ${token}`);
  expect(target).not.toHaveBeenCalled();
  for (const value of [
    { port: 0, token },
    { port: 65536, token },
    { port: "80", token },
    { port: 80, token: "short" },
    { url: "https://example.com", token },
  ]) {
    await NodeFSP.writeFile(redirect, JSON.stringify(value));
    expect(await f.run(config, (s) => s.snapshot())).toMatchObject({ status: "unavailable" });
  }
  expect(requestSeen).toHaveBeenCalledOnce();
});

it("bounds configuration, descriptors and response bodies; reports no secret causes or logs", async () => {
  await using f = await fixture();
  using log = vi.spyOn(console, "log");
  using error = vi.spyOn(console, "error");
  const primary = await f.descriptor("primary", (_req, res) => res.end(JSON.stringify(journal)));
  for (const raw of [
    "{",
    "x".repeat(32769),
    JSON.stringify(
      Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, descriptorFile: `/tmp/${i}` })),
    ),
    JSON.stringify([{ id: "primary", descriptorFile: "/tmp/x" }]),
    JSON.stringify([{ id: "x", descriptorFile: "relative" }]),
    JSON.stringify([
      { id: "x", descriptorFile: "/tmp/x" },
      { id: "x", descriptorFile: "/tmp/y" },
    ]),
  ]) {
    expect(
      await f.run(
        { T3CODE_PRIVACY_OBSERVER_FILE: primary, T3CODE_PRIVACY_OBSERVER_SOURCES: raw },
        (s) => s.snapshots(),
      ),
    ).toMatchObject({
      configuration: "invalid-extras",
      sources: [{ id: "primary", status: "available" }],
    });
  }
  const large = await f.descriptor("large", (_req, res) =>
    res.end("x".repeat(2 * 1024 * 1024 + 1)),
  );
  expect(await f.run({ T3CODE_PRIVACY_OBSERVER_FILE: large }, (s) => s.snapshot())).toMatchObject({
    status: "unavailable",
  });
  await NodeFSP.writeFile(large, "x".repeat(4097));
  expect(await f.run({ T3CODE_PRIVACY_OBSERVER_FILE: large }, (s) => s.snapshot())).toMatchObject({
    status: "unavailable",
  });
  expect(log).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
});

it("times out a stalled source without hiding the primary and closes the request", async () => {
  await using f = await fixture();
  const received = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const primary = await f.descriptor("primary", (_req, res) => res.end(JSON.stringify(journal)));
  const stalled = await f.descriptor("stalled", (req, _res) => {
    req.on("close", () => closed.resolve());
    received.resolve();
  });
  const result = await f.run(
    {
      T3CODE_PRIVACY_OBSERVER_FILE: primary,
      T3CODE_PRIVACY_OBSERVER_SOURCES: JSON.stringify([{ id: "stalled", descriptorFile: stalled }]),
    },
    (s) =>
      Effect.gen(function* () {
        const pending = yield* Effect.forkChild(s.snapshot("stalled"));
        yield* Effect.promise(() => received.promise);
        yield* TestClock.adjust("6 seconds");
        const extra = yield* Fiber.join(pending);
        yield* Effect.promise(() => closed.promise);
        const main = yield* s.snapshot();
        return [main.status, extra.status];
      }).pipe(Effect.provide(TestClock.layer())),
  );
  expect(result).toEqual(["available", "unavailable"]);
});

it("keeps a fresh primary while extras are stale or unavailable, and reloads credentials", async () => {
  await using f = await fixture();
  const first = await f.descriptor("first", (_req, res) =>
    res.end(JSON.stringify({ ...journal, generatedAt: 120 })),
  );
  const second = await f.descriptor("second", (_req, res) =>
    res.end(JSON.stringify({ ...journal, generatedAt: 1 })),
  );
  const bad = await f.descriptor("bad", (_req, res) => {
    res.writeHead(503);
    res.end(token);
  });
  const result = await f.run(
    {
      T3CODE_PRIVACY_OBSERVER_FILE: first,
      T3CODE_PRIVACY_OBSERVER_SOURCES: JSON.stringify([
        { id: "stale", descriptorFile: second },
        { id: "bad", descriptorFile: bad },
      ]),
    },
    (s) =>
      Effect.gen(function* () {
        yield* TestClock.adjust("120 seconds");
        const all = yield* s.snapshots();
        yield* Effect.promise(() => NodeFSP.writeFile(first, JSON.stringify({ port: 0, token })));
        const rotated = yield* s.snapshot();
        return { all, rotated };
      }).pipe(Effect.provide(TestClock.layer())),
  );
  expect(result.all.sources.map((s) => [s.status, s.freshness])).toEqual([
    ["available", "fresh"],
    ["available", "stale"],
    ["unavailable", "unknown"],
  ]);
  expect(result.rotated.status).toBe("unavailable");
});
