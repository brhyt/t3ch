import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import {
  OrchestrationV2ProjectedTurnItem,
  ThreadConversationId,
  type ThreadConversation,
} from "@t3tools/contracts";
import { filterConversationTurnItems, sortThreadConversations } from "./threadConversations.ts";

const auth = ThreadConversationId.make("auth");
const nav = ThreadConversationId.make("nav");
const at = "2026-10-16T12:00:00.000Z";
const decode = Schema.decodeUnknownSync(OrchestrationV2ProjectedTurnItem);
function row(
  position: number,
  runId: string,
  fields: Record<string, unknown>,
  sourceThreadId = "thread",
) {
  return decode({
    position,
    visibility: "local",
    sourceThreadId,
    sourceItemId: `item-${position}`,
    item: {
      id: `item-${position}`,
      threadId: sourceThreadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: position,
      status: "completed",
      title: null,
      startedAt: DateTime.makeUnsafe(at),
      completedAt: DateTime.makeUnsafe(at),
      updatedAt: DateTime.makeUnsafe(at),
      ...fields,
    },
  });
}
function user(position: number, runId: string, conversationIds: readonly ThreadConversationId[]) {
  return row(position, runId, {
    type: "user_message",
    messageId: `message-${position}`,
    text: "Follow up",
    inputIntent: "turn_start",
    createdBy: "user",
    creationSource: "web",
    attachments: [],
    conversationIds,
  });
}
function answer(position: number, runId: string) {
  return row(position, runId, {
    type: "assistant_message",
    messageId: `message-${position}`,
    text: "Result",
    streaming: false,
  });
}
const ids = (rows: readonly OrchestrationV2ProjectedTurnItem[]) => rows.map(({ item }) => item.id);

describe("conversation history", () => {
  it("keeps interleaved runs separate and applies steering membership only forward", () => {
    const items = [
      user(0, "a", [auth]),
      answer(1, "a"),
      user(2, "b", [nav]),
      answer(3, "a"),
      user(4, "a", [nav]),
      answer(5, "b"),
      answer(6, "a"),
    ];
    expect(ids(filterConversationTurnItems(items, auth))).toEqual(["item-0", "item-1", "item-3"]);
    expect(ids(filterConversationTurnItems(items, nav))).toEqual([
      "item-2",
      "item-4",
      "item-5",
      "item-6",
    ]);
    expect(filterConversationTurnItems(items, null)).toBe(items);
  });
  it("allows one exchange in multiple conversations and an unassigned follow-up", () => {
    const items = [user(0, "a", [auth, nav]), answer(1, "a"), user(2, "a", []), answer(3, "a")];
    expect(ids(filterConversationTurnItems(items, auth))).toEqual(["item-0", "item-1"]);
    expect(ids(filterConversationTurnItems(items, nav))).toEqual(["item-0", "item-1"]);
  });
  it("includes work output and keeps an actionable approval reachable in every view", () => {
    const items = [
      user(0, "a", [auth]),
      row(1, "a", { type: "command_execution", input: "test", output: "passed" }),
      user(2, "b", [nav]),
      row(3, "b", {
        type: "approval_request",
        requestId: "approval",
        requestKind: "command",
        status: "pending",
      }),
    ];
    expect(ids(filterConversationTurnItems(items, auth))).toEqual(["item-0", "item-1", "item-3"]);
  });
  it("does not guess memberships for orphan records or another source thread", () => {
    const items = [
      answer(0, "a"),
      user(1, "a", [auth]),
      row(
        2,
        "a",
        { type: "assistant_message", messageId: "other", text: "Other thread", streaming: false },
        "other",
      ),
    ];
    expect(ids(filterConversationTurnItems(items, auth))).toEqual(["item-1"]);
  });
  it("uses the preceding retained anchor for a clipped history window, never a later steer", () => {
    const earlier = user(0, "a", [auth]);
    const later = user(4, "a", [nav]);
    const items = [answer(2, "a"), later, answer(5, "a")];
    const anchors = [later.item, earlier.item];
    expect(ids(filterConversationTurnItems(items, auth, anchors))).toEqual(["item-2"]);
    expect(ids(filterConversationTurnItems(items, nav, anchors))).toEqual(["item-4", "item-5"]);
  });
});

it("sorts by attention state without reordering peers on each update", () => {
  const conversation = (id: string, state: ThreadConversation["state"]): ThreadConversation => ({
    id: ThreadConversationId.make(id),
    title: id,
    goal: null,
    state,
    createdAt: at,
    updatedAt: at,
  });
  const items = [
    conversation("done", { status: "completed" }),
    conversation("waiting", { status: "waiting", reason: "Dependency" }),
    conversation("b", { status: "active" }),
    conversation("decision", { status: "decision_needed", question: "Which one?" }),
    conversation("a", { status: "active" }),
  ];
  expect(sortThreadConversations(items).map((item) => item.id)).toEqual([
    "decision",
    "a",
    "b",
    "waiting",
    "done",
  ]);
  const first = items[0];
  expect(first?.id).toBe("done");
});
