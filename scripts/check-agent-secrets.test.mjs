import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const scanner = NodeURL.fileURLToPath(new URL("./check-agent-secrets.mjs", import.meta.url));

NodeTest.test(
  "checks the staged content, refuses permission history, and never prints credentials",
  () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agent-secrets-"));
    const git = (...args) => NodeChildProcess.execFileSync("git", args, { cwd, stdio: "pipe" });
    const scan = () =>
      NodeChildProcess.spawnSync(process.execPath, [scanner], { cwd, encoding: "utf8" });
    try {
      git("init", "-q");
      NodeFS.mkdirSync(NodePath.join(cwd, ".claude"));
      const config = NodePath.join(cwd, ".claude/settings.json");
      NodeFS.writeFileSync(
        config,
        JSON.stringify({ permissions: { allow: ["Bash(DB_URL=$DB_URL tool)"] } }),
      );
      git("add", ".claude/settings.json");
      NodeAssert.equal(scan().status, 0);
      const secret = "fixture-password-never-print";
      NodeFS.writeFileSync(
        config,
        JSON.stringify({ permissions: { allow: [`Bash(PGPASSWORD=${secret} psql)`] } }),
      );
      git("add", ".claude/settings.json");
      NodeFS.writeFileSync(config, "{}");
      const result = scan();
      NodeAssert.equal(result.status, 1);
      NodeAssert.ok(!result.stderr.includes(secret));
      git("add", ".claude/settings.json");
      NodeFS.writeFileSync(NodePath.join(cwd, ".claude/settings.local.json"), "{}");
      git("add", ".claude/settings.local.json");
      NodeAssert.equal(scan().status, 1);
    } finally {
      NodeFS.rmSync(cwd, { recursive: true, force: true });
    }
  },
);
