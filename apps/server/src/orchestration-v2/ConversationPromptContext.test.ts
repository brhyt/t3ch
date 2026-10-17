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

  it("gives ordinary turns bounded opt-in organization guidance", () => {
    const text = withConversationPromptContext({
      text: "Hello",
      thread: { conversations: [] },
      message: {},
    });
    expect(text).toContain("Hello");
    expect(text).toContain("When clearly separate work topics emerge");
    expect(text).toContain("Ask the user before ambiguous grouping");
    expect(text).toContain("never mark a topic completed solely");
  });
});
