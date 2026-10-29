import { ThreadConversationId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { withConversationPromptContext } from "./ConversationPromptContext.ts";

describe("withConversationPromptContext", () => {
  it("adds selected topic focus without replacing the user's text or parent context", () => {
    const selected = ThreadConversationId.make("conversation-build");
    const text = withConversationPromptContext({
      text: "Implement the next piece.",
      thread: {
        conversations: [
          {
            id: selected,
            title: "Build",
            goal: "Ship the implementation",
            state: { status: "active" },
            createdAt: "2026-10-16T12:00:00.000Z",
            updatedAt: "2026-10-16T12:00:00.000Z",
          },
        ],
      },
      message: { conversationIds: [selected] },
    });

    expect(text).toContain("Implement the next piece.");
    expect(text).toContain('"title":"Build"');
    expect(text).toContain("full parent thread context");
  });

  it("requires separate deliverables to be organized before work, including within a selected topic", () => {
    const text = withConversationPromptContext({
      text: "Hello",
      thread: { conversations: [] },
      message: {},
    });
    expect(text).toContain("Hello");
    expect(text).toContain("Before beginning work");
    expect(text).toContain(
      "create a new topic for a distinct deliverable without asking permission",
    );
    expect(text).toContain("even when another topic is selected");
    expect(text).toContain("merely invoking a skill does not create a topic");
    expect(text).toContain("Ask the user before ambiguous grouping");
    expect(text).toContain("never mark a topic completed solely");
  });

  it("includes all existing topics so an unselected or completed topic can be reused", () => {
    const multitask = {
      id: ThreadConversationId.make("multitask"),
      title: "Multitask",
      goal: "Run parallel work",
      state: { status: "completed" } as const,
      createdAt: "2026-10-16T12:00:00.000Z",
      updatedAt: "2026-10-16T12:00:00.000Z",
    };
    const skills = {
      ...multitask,
      id: ThreadConversationId.make("skill-actions"),
      title: "Skill actions",
      goal: "Discover skill commands",
      state: { status: "active" } as const,
    };
    const text = withConversationPromptContext({
      text: "Also audit skill command tables.",
      thread: { conversations: [multitask, skills] },
      message: { conversationIds: [multitask.id] },
    });
    const json = text.split("<t3_conversation_context>")[1]?.split("</t3_conversation_context>")[0];
    expect(json).toBeDefined();
    const context: unknown = JSON.parse(json ?? "null");
    const multitaskContext = {
      id: "multitask",
      title: "Multitask",
      goal: "Run parallel work",
      state: { status: "completed" },
    };
    const skillContext = {
      id: "skill-actions",
      title: "Skill actions",
      goal: "Discover skill commands",
      state: { status: "active" },
    };
    expect(context).toEqual({
      conversations: [multitaskContext, skillContext],
      selectedConversations: [multitaskContext],
      instruction: expect.any(String),
    });
    expect(text.startsWith("Also audit skill command tables.")).toBe(true);
  });
});
