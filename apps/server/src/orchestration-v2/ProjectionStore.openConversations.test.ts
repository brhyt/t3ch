import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadConversationId,
  ThreadId,
  type ModelSelection,
  type ThreadConversation,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

it.effect("thread shells carry only open topics, so to-do lists need no thread loads", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const at = DateTime.formatIso(now);
    const threadId = ThreadId.make("thread:open-topics");
    const topic = (id: string, state: ThreadConversation["state"]): ThreadConversation => ({
      id: ThreadConversationId.make(id),
      title: id,
      goal: null,
      state,
      createdAt: at,
      updatedAt: at,
    });
    const payload = (conversations: ReadonlyArray<ThreadConversation>) => ({
      createdBy: "user" as const,
      creationSource: "web" as const,
      id: threadId,
      projectId: ProjectId.make("project:open-topics"),
      title: "Open topics",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
      conversations,
    });
    const shells = Effect.gen(function* () {
      const snapshot = yield* store.getShellSnapshot();
      return [
        snapshot.threads.find((thread) => thread.id === threadId),
        yield* store.getThreadShell(threadId),
        ProjectionStore.threadShellFromProjection(yield* store.getThreadProjection(threadId)),
      ].map((shell) => shell?.openConversations?.map((conversation) => conversation.id));
    });

    yield* store.apply({
      id: EventId.make("event:open-topics:created"),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: payload([
        topic("decide", { status: "decision_needed", question: "Which API?" }),
        topic("done", { status: "completed" }),
        topic("wait", { status: "waiting", reason: "CI" }),
      ]),
    });
    const open = ["decide", "wait"];
    assert.deepEqual(yield* shells, [open, open, open]);

    yield* store.apply({
      id: EventId.make("event:open-topics:all-done"),
      type: "thread.metadata-updated",
      threadId,
      occurredAt: now,
      payload: payload([topic("decide", { status: "completed" })]),
    });
    assert.deepEqual(yield* shells, [undefined, undefined, undefined]);
  }).pipe(Effect.provide(layerTest)),
);
