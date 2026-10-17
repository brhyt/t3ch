import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2TurnItem,
  ThreadConversation,
  ThreadConversationId,
  ThreadConversationState,
} from "@t3tools/contracts";

const statusOrder = { decision_needed: 0, active: 1, waiting: 2, completed: 3 };

export function sortThreadConversations(conversations: readonly ThreadConversation[]) {
  return [...conversations].sort(
    (a, b) =>
      statusOrder[a.state.status] - statusOrder[b.state.status] ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
}

export function threadConversationStatusLabel(state: ThreadConversationState): string {
  switch (state.status) {
    case "decision_needed":
      return "Decision needed";
    case "active":
      return "Active";
    case "waiting":
      return "Waiting";
    case "completed":
      return "Completed";
  }
}

export function filterConversationTurnItems<T extends OrchestrationV2ProjectedTurnItem>(
  items: readonly T[],
  conversationId: ThreadConversationId | null,
  anchorItems: readonly OrchestrationV2TurnItem[] = [],
): readonly T[] {
  if (conversationId === null) return items;
  const memberships = new Map<string, readonly ThreadConversationId[]>();
  const firstOrdinal = new Map<string, number>();
  for (const { sourceThreadId, item } of items) {
    const key = JSON.stringify([sourceThreadId, item.runId]);
    if (!firstOrdinal.has(key)) firstOrdinal.set(key, item.ordinal);
  }
  const anchorOrdinals = new Map<string, number>();
  for (const item of anchorItems) {
    if (item.type !== "user_message") continue;
    const key = JSON.stringify([item.threadId, item.runId]);
    const first = firstOrdinal.get(key);
    if (
      first === undefined ||
      item.ordinal > first ||
      item.ordinal <= (anchorOrdinals.get(key) ?? -1)
    )
      continue;
    anchorOrdinals.set(key, item.ordinal);
    memberships.set(key, item.conversationIds ?? []);
  }
  return items.filter(({ sourceThreadId, item }) => {
    const key = JSON.stringify([sourceThreadId, item.runId]);
    // Steering creates another exchange within the same run; apply its membership only forward.
    if (item.type === "user_message") memberships.set(key, item.conversationIds ?? []);
    if (
      (item.type === "approval_request" ||
        item.type === "user_input_request" ||
        item.type === "secret_request") &&
      (item.status === "pending" || item.status === "waiting" || item.status === "running")
    )
      return true;
    return memberships.get(key)?.includes(conversationId) ?? false;
  });
}
