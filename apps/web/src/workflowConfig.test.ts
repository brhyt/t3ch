import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderSkill } from "@t3tools/contracts";
import {
  appendWorkflowContext,
  readWorkflowContext,
  workflowBlockReason,
  workflowDisplayText,
  workflowSkills,
  type WorkflowConfig,
} from "./workflowConfig";

const skill: ServerProviderSkill = {
  name: "poteto-mode",
  path: "/skills/poteto-mode/SKILL.md",
  enabled: true,
};
const config: WorkflowConfig = {
  skillName: skill.name,
  skillPath: skill.path,
  assignments: {},
};

describe("workflow turn context", () => {
  it("preserves the sent workflow when the next turn switches modes or assignments", () => {
    const sent = appendWorkflowContext("Fix the button", config);
    const next = {
      ...config,
      skillName: "rasmic-mode",
      assignments: {
        review: { providerInstanceId: "claude", model: "opus" },
      },
    };
    expect(readWorkflowContext(sent)).toEqual(config);
    expect(readWorkflowContext(appendWorkflowContext("Review it", next))).toEqual(next);
    expect(workflowDisplayText(sent)).toBe("Fix the button");
    expect(sent).toContain("Read its SKILL.md");
  });

  it("keeps native commands and messages with no selected workflow unchanged", () => {
    expect(appendWorkflowContext("/compact", config)).toBe("/compact");
    expect(appendWorkflowContext("Implement this", null)).toBe("Implement this");
  });

  it("preserves legacy context following a workflow block", () => {
    const sent = appendWorkflowContext("Fix this", config) + "\nAttachment context";
    expect(workflowDisplayText(sent)).toBe("Fix this\nAttachment context");
  });

  it("does not hide invalid or incomplete workflow context", () => {
    const invalid = 'Hello\n\n<t3-workflow-v1>\n{"skillName":42}\n</t3-workflow-v1>';
    expect(readWorkflowContext(invalid)).toBeNull();
    expect(workflowDisplayText(invalid)).toBe(invalid);
    expect(readWorkflowContext("Hello\n\n<t3-workflow-v1>\n{")).toBeNull();
  });

  it("requires the enabled skill in the destination provider and workspace", () => {
    expect(workflowBlockReason(config, [skill], [])).toBeNull();
    expect(workflowBlockReason(config, [], [])).toContain("unavailable");
    expect(workflowBlockReason(config, [{ ...skill, path: "/elsewhere/SKILL.md" }], [])).toContain(
      "unavailable",
    );
    expect(workflowBlockReason(config, [{ ...skill, enabled: false }], [])).toContain(
      "unavailable",
    );
    expect(workflowBlockReason(config, [{ ...skill, userInvocationOnly: true }], [])).toContain(
      "native slash command",
    );
  });

  it("blocks unavailable explicit routes instead of silently changing the cast", () => {
    expect(
      workflowBlockReason(
        {
          ...config,
          assignments: {
            verify: { providerInstanceId: "missing", model: "opus" },
          },
        },
        [skill],
        [],
      ),
    ).toContain("verify assignment is unavailable");
  });

  it("discovers installed mode skills without pretending other skills are workflows", () => {
    expect(
      workflowSkills([
        skill,
        { ...skill, name: "rasmic-mode" },
        { ...skill, name: "screenshot" },
      ]).map((entry) => entry.name),
    ).toEqual(["poteto-mode", "rasmic-mode"]);
  });
});
