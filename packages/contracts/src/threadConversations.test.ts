import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ThreadConversationMutation, ThreadConversationState } from "./threadConversations.ts";

describe("conversation mutations", () => {
  const decode = Schema.decodeUnknownSync(ThreadConversationMutation);
  it("requires a question for a decision and a reason for waiting", () => {
    const state = Schema.decodeUnknownSync(ThreadConversationState);
    expect(() => state({ status: "decision_needed" })).toThrow();
    expect(() => state({ status: "waiting" })).toThrow();
    expect(state({ status: "decision_needed", question: "Which callback destination?" })).toEqual({
      status: "decision_needed",
      question: "Which callback destination?",
    });
  });
  it("supports explicit removal of exchange assignments and reopening", () => {
    expect(decode({ type: "assign", messageIds: ["message-1"], conversationIds: [] })).toEqual({
      type: "assign",
      messageIds: ["message-1"],
      conversationIds: [],
    });
    expect(decode({ type: "update", id: "auth", state: { status: "active" } })).toEqual({
      type: "update",
      id: "auth",
      state: { status: "active" },
    });
  });
  it("rejects empty changes, blank titles, and duplicate membership", () => {
    expect(() => decode({ type: "update", id: "auth" })).toThrow();
    expect(() => decode({ type: "create", id: "auth", title: "   " })).toThrow();
    expect(() =>
      decode({ type: "assign", messageIds: ["m"], conversationIds: ["auth", "auth"] }),
    ).toThrow();
  });
});
