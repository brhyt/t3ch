import { describe, expect, it } from "vite-plus/test";

import { MAX_PROVIDER_SKILL_ACTIONS, parseProviderSkillActions } from "./providerSkillActions.ts";

describe("parseProviderSkillActions", () => {
  it("uses explicit frontmatter actions without inventing aliases", () => {
    expect(
      parseProviderSkillActions(`---
actions:
  - command: dg:judge
    usage: dg:judge <piece>
    description: Judge one existing artifact
  - command: dg:optimize
    description: Optimize a won direction
---

| Command | Job |
|---|---|
| \`dg:ignored\` | Frontmatter is authoritative |
`),
    ).toEqual([
      {
        command: "dg:judge",
        usage: "dg:judge <piece>",
        description: "Judge one existing artifact",
      },
      {
        command: "dg:optimize",
        usage: "dg:optimize",
        description: "Optimize a won direction",
      },
    ]);
  });

  it("falls back to Command and Job tables and handles escaped pipes", () => {
    expect(
      parseProviderSkillActions(`## Commands

| Command | Load | Job |
|:--|:--|:--|
| \`dg:interpret <brief\\|ref>\` | reference | Cross-family interpretation |
| \`dg:judge <piece>\` | reference | One judging round |
`),
    ).toEqual([
      {
        command: "dg:interpret",
        usage: "dg:interpret <brief|ref>",
        description: "Cross-family interpretation",
      },
      {
        command: "dg:judge",
        usage: "dg:judge <piece>",
        description: "One judging round",
      },
    ]);
  });

  it("preserves distinct literal invocation prefixes from the Design Graph command table", () => {
    const rows = [
      "dg:run [goal]",
      "dg:explore [run]",
      "dg:reinterpret [run]",
      "dg:interpret <brief\\|ref>",
      "dg:bar <reference>",
      "dg:judge <piece>",
      "dg:resume <run>",
      "dg:experiment <brief> <refs…>",
      "dg:inspire [run]",
      "dg:dna <winner>",
      "dg:dna --reference <ref>",
      "dg:optimize <run> [--axis <name>]",
      "dg:live [run]",
      "dg:wireframe [run]",
      "dg:copy-copy [run]",
      "dg:alive",
      "dg:status [run]",
      "dg:probe [run]",
      "dg:observe [run]",
    ].map((usage) => `| \`${usage}\` | reference | Job |`);
    const actions = parseProviderSkillActions(
      ["| Command | Load | Job |", "|:--|:--|:--|", ...rows].join("\n"),
    );

    expect(actions).toHaveLength(19);
    expect(actions.filter((action) => action.command.startsWith("dg:dna"))).toEqual([
      { command: "dg:dna", usage: "dg:dna <winner>", description: "Job" },
      {
        command: "dg:dna --reference",
        usage: "dg:dna --reference <ref>",
        description: "Job",
      },
    ]);
    expect(actions.find((action) => action.command === "dg:optimize")?.usage).toBe(
      "dg:optimize <run> [--axis <name>]",
    );
  });

  it("deduplicates commands and caps the result", () => {
    const rows = Array.from(
      { length: MAX_PROVIDER_SKILL_ACTIONS + 10 },
      (_, index) => `| \`dg:action-${index}\` | Action ${index} |`,
    ).join("\n");
    const actions = parseProviderSkillActions(
      `| Command | Description |\n|---|---|\n| \`dg:action-0\` | First |\n${rows}`,
    );
    expect(actions).toHaveLength(MAX_PROVIDER_SKILL_ACTIONS);
    expect(actions[0]?.description).toBe("First");
  });
});
