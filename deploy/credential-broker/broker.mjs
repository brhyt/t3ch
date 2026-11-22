import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodePerfHooks from "node:perf_hooks";

const scope = "fixture.ping";
const leases = new Map();
const digest = (s) => NodeCrypto.createHash("sha256").update(s).digest("hex");
const reply = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
};
async function body(req) {
  let value = "";
  for await (const chunk of req) {
    value += chunk;
    if (value.length > 1024) throw new Error("invalid");
  }
  return JSON.parse(value);
}
const exact = (v, keys) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(",") === keys.sort().join(",");
function server(handler) {
  const s = NodeHttp.createServer(
    { maxHeaderSize: 4096, requestTimeout: 3000, headersTimeout: 3000 },
    (req, res) => {
      handler(req, res).catch(() => reply(res, 400, { error: "invalid request" }));
    },
  );
  s.maxConnections = 32;
  s.on("clientError", (_err, socket) =>
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"),
  );
  return s;
}

function start() {
  if (process.env.BROKER_SYNTHETIC_ONLY !== "1") throw new Error("disabled");
  const credential = NodeFS.readFileSync("/run/credential", "utf8");
  if (!/^synthetic-[a-f0-9]{64}$/.test(credential)) throw new Error("invalid fixture");
  // No URL, method, path, header, or body comes from the workload.
  function operation() {
    return new Promise((resolve) => {
      const request = NodeHttp.request(
        {
          hostname: "upstream",
          port: 8080,
          path: "/fixture/ping",
          method: "POST",
          headers: { authorization: `Bearer ${credential}`, "content-length": "0" },
          timeout: 2000,
        },
        (res) => {
          const ok = res.statusCode === 204;
          res.destroy();
          resolve(ok);
        },
      );
      request.on("timeout", () => request.destroy());
      request.on("error", () => resolve(false));
      request.end();
    });
  }
  const admin = server(async (req, res) => {
    if (req.method !== "POST") return reply(res, 404, { error: "not found" });
    const value = await body(req);
    if (req.url === "/leases") {
      if (
        !exact(value, ["scope", "ttlMs"]) ||
        value.scope !== scope ||
        !Number.isInteger(value.ttlMs) ||
        value.ttlMs < 1 ||
        value.ttlMs > 30000
      )
        return reply(res, 400, { error: "invalid grant" });
      for (const [key, expiry] of leases)
        if (expiry <= NodePerfHooks.performance.now()) leases.delete(key);
      if (leases.size >= 256) return reply(res, 429, { error: "capacity" });
      const token = NodeCrypto.randomBytes(32).toString("hex");
      leases.set(digest(token), NodePerfHooks.performance.now() + value.ttlMs);
      return reply(res, 201, { token, scope, ttlMs: value.ttlMs, uses: 1 });
    }
    if (req.url === "/revoke" && exact(value, ["token"]) && typeof value.token === "string") {
      leases.delete(digest(value.token));
      return reply(res, 200, { ok: true });
    }
    return reply(res, 400, { error: "invalid request" });
  });
  const workload = server(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/operate")
      return reply(res, 404, { error: "not found" });
    if (req.headers.authorization || req.headers["proxy-authorization"])
      return reply(res, 400, { error: "invalid request" });
    const value = await body(req);
    if (
      !exact(value, ["scope", "lease"]) ||
      value.scope !== scope ||
      typeof value.lease !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.lease)
    ) {
      return reply(res, 400, { error: "invalid request" });
    }
    const key = digest(value.lease);
    const expiry = leases.get(key);
    leases.delete(key); // Consume before any asynchronous operation, including failed upstream calls.
    if (expiry === undefined || NodePerfHooks.performance.now() >= expiry)
      return reply(res, 403, { error: "denied" });
    return (await operation())
      ? reply(res, 200, { ok: true })
      : reply(res, 502, { error: "operation failed" });
  });
  let listening = 0;
  const ready = () => {
    if (++listening === 2) process.stdout.write("ready\n");
  };
  admin.listen(8081, "127.0.0.1", ready);
  workload.listen(8080, "0.0.0.0", ready);
}
try {
  start();
} catch {
  process.stderr.write("broker startup failed\n");
  process.exitCode = 1;
}
