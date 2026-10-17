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
  const conversations = (input.thread.conversations ?? []).filter((conversation) =>
    selectedIds.has(conversation.id),
  );
  const context = conversations.map(({ id, title, goal, state }) => ({ id, title, goal, state }));
  return `${input.text}\n\n<t3_conversation_context>${JSON.stringify({
    ...(context.length === 0 ? {} : { selectedConversations: context }),
    instruction:
      "Keep the full parent thread context. If selectedConversations is present, focus this response there. When clearly separate work topics emerge, use t3_conversation_list and t3_conversation_update to organize them. Ask the user before ambiguous grouping, update topic states explicitly, and never mark a topic completed solely because a provider run ended.",
  })}</t3_conversation_context>`;
}
