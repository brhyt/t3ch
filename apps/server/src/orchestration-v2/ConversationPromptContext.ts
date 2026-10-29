import type {
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";

export function withConversationPromptContext(input: {
  readonly text: string;
  readonly thread: Pick<OrchestrationV2AppThread, "conversations">;
  readonly message: Pick<OrchestrationV2ConversationMessage, "conversationIds">;
}): string {
  const selectedIds = new Set(input.message.conversationIds ?? []);
  const conversations = (input.thread.conversations ?? []).map(({ id, title, goal, state }) => ({
    id,
    title,
    goal,
    state,
  }));
  const selectedConversations = conversations.filter((conversation) =>
    selectedIds.has(conversation.id),
  );
  return `${input.text}\n\n<t3_conversation_context>${JSON.stringify({
    conversations,
    ...(selectedConversations.length === 0 ? {} : { selectedConversations }),
    instruction:
      "Keep the full parent thread context. Before beginning work, organize each independently actionable request as its own conversation topic using t3_conversation_list and t3_conversation_update. Reuse a matching topic; create a new topic for a distinct deliverable without asking permission. Selected conversations focus the response but do not prevent new topics: if a message introduces separate work, create and assign that topic even when another topic is selected. For example, adding skill-trigger discovery while discussing Multitask requires a separate topic. Continuing discussion, implementation, and testing of the same deliverable stays in its existing topic; merely invoking a skill does not create a topic. Read user message IDs with t3_thread_read and assign the originating exchange to every applicable topic, including multiple topics for a mixed request. Ask the user before ambiguous grouping. Update topic states explicitly, and never mark a topic completed solely because a provider run ended.",
  })}</t3_conversation_context>`;
}
