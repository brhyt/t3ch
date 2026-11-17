import type { EnvironmentId, ProjectId, ThreadConversation, ThreadId } from "@t3tools/contracts";

import { scopedThreadKey } from "./environment/scoped.ts";

/** The shell fields the to-do list reads, so web and mobile thread models both fit. */
export interface ThreadTodoSource {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
  readonly source: { readonly openConversations?: ReadonlyArray<ThreadConversation> | undefined };
}

export interface ThreadTodo {
  /** Unique across environments: the scoped thread key plus the topic id. */
  readonly key: string;
  readonly threadKey: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly threadTitle: string;
  readonly conversation: ThreadConversation;
}

const todoStatusRank = { decision_needed: 0, waiting: 1, active: 2, completed: 3 } as const;

/**
 * Every open topic on listed threads, decisions first, then waits, then active work;
 * newest change first within a group. `environmentId` narrows to one machine.
 */
export function collectThreadTodos(
  threads: ReadonlyArray<ThreadTodoSource>,
  environmentId: EnvironmentId | null = null,
): ReadonlyArray<ThreadTodo> {
  const todos: ThreadTodo[] = [];
  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
    if (environmentId !== null && thread.environmentId !== environmentId) continue;
    const conversations = thread.source.openConversations;
    if (conversations === undefined || conversations.length === 0) continue;
    const threadKey = scopedThreadKey({ environmentId: thread.environmentId, threadId: thread.id });
    for (const conversation of conversations) {
      if (conversation.state.status === "completed") continue;
      todos.push({
        key: `${threadKey}\n${conversation.id}`,
        threadKey,
        environmentId: thread.environmentId,
        threadId: thread.id,
        projectId: thread.projectId,
        threadTitle: thread.title,
        conversation,
      });
    }
  }
  return todos.sort(
    (left, right) =>
      todoStatusRank[left.conversation.state.status] -
        todoStatusRank[right.conversation.state.status] ||
      right.conversation.updatedAt.localeCompare(left.conversation.updatedAt) ||
      left.key.localeCompare(right.key),
  );
}

/** The line under a to-do's title: what it needs from the user, if anything. */
export function threadTodoDetail(conversation: ThreadConversation): string | null {
  switch (conversation.state.status) {
    case "decision_needed":
      return conversation.state.question;
    case "waiting":
      return conversation.state.reason;
    case "active":
    case "completed":
      return conversation.goal;
  }
}

/**
 * The to-do after `currentKey`, wrapping to the first. A current to-do that left the
 * list, e.g. because it was just marked done, restarts at the top.
 */
export function nextThreadTodo(
  todos: ReadonlyArray<ThreadTodo>,
  currentKey: string | null,
): ThreadTodo | null {
  if (todos.length === 0) return null;
  const index = currentKey === null ? -1 : todos.findIndex((todo) => todo.key === currentKey);
  if (index === -1) return todos[0]!;
  return todos.length === 1 ? null : todos[(index + 1) % todos.length]!;
}

/**
 * A remembered machine filter applies only while that machine is connected and is
 * one of several; otherwise every machine shows, and the choice returns with the machine.
 */
export function resolveMachineFilter(
  chosen: EnvironmentId | null,
  connectedEnvironmentIds: ReadonlyArray<EnvironmentId>,
): EnvironmentId | null {
  if (chosen === null || connectedEnvironmentIds.length < 2) return null;
  return connectedEnvironmentIds.includes(chosen) ? chosen : null;
}
