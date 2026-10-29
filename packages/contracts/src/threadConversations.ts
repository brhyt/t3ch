import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  MessageId,
  ThreadConversationId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const ConversationTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(120));
const ConversationDetail = TrimmedNonEmptyString.check(Schema.isMaxLength(2000));

export const ThreadConversationState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("active") }),
  Schema.Struct({
    status: Schema.Literal("decision_needed"),
    question: ConversationDetail,
    sourceMessageId: Schema.optional(MessageId),
  }),
  Schema.Struct({ status: Schema.Literal("waiting"), reason: ConversationDetail }),
  Schema.Struct({ status: Schema.Literal("completed") }),
]);
export type ThreadConversationState = typeof ThreadConversationState.Type;

export const ThreadConversation = Schema.Struct({
  id: ThreadConversationId,
  title: ConversationTitle,
  goal: Schema.NullOr(ConversationDetail),
  state: ThreadConversationState,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadConversation = typeof ThreadConversation.Type;

export const ThreadConversationIds = Schema.Array(ThreadConversationId).check(
  Schema.isMaxLength(20),
  Schema.makeFilter((ids) => new Set(ids).size === ids.length),
);

export const ThreadConversationMutation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("create"),
    id: ThreadConversationId,
    title: ConversationTitle,
    goal: Schema.optional(Schema.NullOr(ConversationDetail)),
    state: Schema.optional(ThreadConversationState),
  }),
  Schema.Struct({
    type: Schema.Literal("update"),
    id: ThreadConversationId,
    title: Schema.optional(ConversationTitle),
    goal: Schema.optional(Schema.NullOr(ConversationDetail)),
    state: Schema.optional(ThreadConversationState),
  }).check(
    Schema.makeFilter(
      (input) => input.title !== undefined || input.goal !== undefined || input.state !== undefined,
    ),
  ),
  Schema.Struct({
    type: Schema.Literal("assign"),
    messageIds: Schema.Array(MessageId).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    conversationIds: ThreadConversationIds,
  }),
]);
export type ThreadConversationMutation = typeof ThreadConversationMutation.Type;
