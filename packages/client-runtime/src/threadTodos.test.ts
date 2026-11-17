import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ThreadConversationId,
  ThreadId,
  type ThreadConversation,
  type ThreadConversationState,
} from "@t3tools/contracts";

import {
  collectThreadTodos,
  nextThreadTodo,
  resolveMachineFilter,
  type ThreadTodoSource,
} from "./threadTodos.ts";

const laptop = EnvironmentId.make("laptop");
const server = EnvironmentId.make("server");

function topic(id: string, state: ThreadConversationState, updatedAt: string): ThreadConversation {
  return {
    id: ThreadConversationId.make(id),
    title: id,
    goal: null,
    state,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt,
  };
}

function thread(
  id: string,
  conversations: ReadonlyArray<ThreadConversation> | undefined,
  overrides: Partial<ThreadTodoSource> = {},
): ThreadTodoSource {
  return {
    environmentId: laptop,
    id: ThreadId.make(id),
    projectId: ProjectId.make("project"),
    title: id,
    archivedAt: null,
    deletedAt: null,
    source: conversations === undefined ? {} : { openConversations: conversations },
    ...overrides,
  };
}

const ids = (todos: ReturnType<typeof collectThreadTodos>) =>
  todos.map((todo) => todo.conversation.id);

describe("collectThreadTodos", () => {
  it("orders decisions, then waits, then active work, newest first within each", () => {
    const todos = collectThreadTodos([
      thread("a", [
        topic("active-old", { status: "active" }, "2026-11-02T00:00:00.000Z"),
        topic("wait", { status: "waiting", reason: "CI" }, "2026-11-01T00:00:00.000Z"),
      ]),
      thread("b", [
        topic("active-new", { status: "active" }, "2026-11-05T00:00:00.000Z"),
        topic(
          "decide-old",
          { status: "decision_needed", question: "?" },
          "2026-11-01T00:00:00.000Z",
        ),
        topic(
          "decide-new",
          { status: "decision_needed", question: "?" },
          "2026-11-03T00:00:00.000Z",
        ),
      ]),
    ]);
    expect(ids(todos)).toEqual(["decide-new", "decide-old", "wait", "active-new", "active-old"]);
  });

  it("skips archived and deleted threads and completed topics", () => {
    const at = "2026-11-01T00:00:00.000Z";
    const todos = collectThreadTodos([
      thread("archived", [topic("x", { status: "active" }, at)], { archivedAt: at }),
      thread("deleted", [topic("y", { status: "active" }, at)], { deletedAt: at }),
      thread("open", [
        topic("done", { status: "completed" }, at),
        topic("z", { status: "active" }, at),
      ]),
      thread("older-server", undefined),
    ]);
    expect(ids(todos)).toEqual(["z"]);
  });

  it("keeps same-id topics on different machines apart and narrows to one machine", () => {
    const at = "2026-11-01T00:00:00.000Z";
    const threads = [
      thread("t", [topic("same", { status: "active" }, at)]),
      thread("t", [topic("same", { status: "active" }, at)], { environmentId: server }),
    ];
    expect(new Set(collectThreadTodos(threads).map((todo) => todo.key)).size).toBe(2);
    expect(collectThreadTodos(threads, server).map((todo) => todo.environmentId)).toEqual([server]);
  });
});

describe("nextThreadTodo", () => {
  const at = "2026-11-01T00:00:00.000Z";
  const todos = collectThreadTodos([
    thread("a", [
      topic("first", { status: "decision_needed", question: "?" }, at),
      topic("second", { status: "active" }, at),
    ]),
  ]);

  it("advances and wraps around", () => {
    expect(nextThreadTodo(todos, todos[0]!.key)?.key).toBe(todos[1]!.key);
    expect(nextThreadTodo(todos, todos[1]!.key)?.key).toBe(todos[0]!.key);
  });

  it("starts at the top when nothing or a finished to-do was open", () => {
    expect(nextThreadTodo(todos, null)?.key).toBe(todos[0]!.key);
    expect(nextThreadTodo(todos, "gone")?.key).toBe(todos[0]!.key);
  });

  it("has no next when the open to-do is the only one", () => {
    expect(nextThreadTodo(todos.slice(0, 1), todos[0]!.key)).toBeNull();
    expect(nextThreadTodo([], null)).toBeNull();
  });
});

describe("resolveMachineFilter", () => {
  it("applies only to a connected machine among several", () => {
    expect(resolveMachineFilter(server, [laptop, server])).toBe(server);
    expect(resolveMachineFilter(server, [laptop, EnvironmentId.make("other")])).toBeNull();
    expect(resolveMachineFilter(server, [server])).toBeNull();
    expect(resolveMachineFilter(null, [laptop, server])).toBeNull();
  });
});
