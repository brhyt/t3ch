import * as NodeChildProcess from "node:child_process";

const git = (...args) =>
  NodeChildProcess.execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const all = process.argv.includes("--all");
const files = (
  all ? git("ls-files", "-z") : git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z")
)
  .split("\0")
  .filter(Boolean);
const localPermissions = /(^|\/)\.claude\/settings\.local\.json$/;
const agentConfig =
  /(^|\/)(?:\.mcp\.json|\.claude\/settings[^/]*\.json|\.codex\/config\.toml|\.cursor\/mcp\.json)$/;
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16})\b/,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:/]+:([^\s@]+)@/i,
  /\b(?:[A-Z_]*(?:PASSWORD|TOKEN|API_KEY|SECRET)|PGPASSWORD)\s*=\s*["']?([A-Za-z0-9][A-Za-z0-9_+/.=-]{7,})/,
];
let failed = false;
for (const file of files) {
  if (localPermissions.test(file)) {
    console.error(`${file}: local permission history must not be committed`);
    failed = true;
    continue;
  }
  if (!agentConfig.test(file)) continue;
  const content = git("show", `:${file}`);
  let literalField = false;
  if (file.endsWith(".json")) {
    const inspect = (value) => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (
          /^(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|secret)$/i.test(
            key,
          ) &&
          typeof child === "string" &&
          child.length > 0 &&
          !child.startsWith("$") &&
          !child.startsWith("op://")
        )
          literalField = true;
        else inspect(child);
      }
    };
    try {
      inspect(JSON.parse(content));
    } catch {
      /* Pattern checks still cover non-JSON configuration. */
    }
  }
  if (literalField || patterns.some((pattern) => pattern.test(content))) {
    console.error(
      `${file}: possible literal credential; use an environment variable or secret reference`,
    );
    failed = true;
  }
}
if (failed) process.exitCode = 1;
else console.log("Agent configuration credential check passed.");
