import { describe, expect, it } from "vite-plus/test";

import { filterSkillActions, skillActionInsertion } from "./skillActionPicker.ts";

const actions = [
  { command: "dg:judge", usage: "dg:judge <piece>", description: "Judge an artifact" },
  { command: "dg:optimize", usage: "dg:optimize <run>", description: "Tune one axis" },
];

describe("skill action picker", () => {
  it("searches command, usage, and description", () => {
    expect(filterSkillActions(actions, "artifact").map((action) => action.command)).toEqual([
      "dg:judge",
    ]);
    expect(filterSkillActions(actions, "<run>").map((action) => action.command)).toEqual([
      "dg:optimize",
    ]);
  });

  it("ranks an exact command name ahead of incidental description matches", () => {
    expect(
      filterSkillActions(
        [
          {
            command: "dg:interpret",
            usage: "dg:interpret <brief>",
            description: "Pick and optimize",
          },
          ...actions,
        ],
        "optimize",
      ).map((action) => action.command),
    ).toEqual(["dg:optimize", "dg:interpret"]);
  });

  it("keeps the selected skill context and inserts only the exact command token", () => {
    expect(skillActionInsertion("design-graph", "dg:judge")).toBe("$design-graph dg:judge ");
    expect(skillActionInsertion("design-graph")).toBe("$design-graph ");
  });
});
