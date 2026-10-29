import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as DelegatedTaskService from "./DelegatedTaskService.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";

it("includes the initial goal and current task in a user multitask prompt", () => {
  const prompt = DelegatedTaskService.composeUserMultitaskPrompt({
    task: "Write child-proof.txt containing inherited-marker-71.",
    parentThreadId: ThreadId.make("thread:multitask:context-parent"),
    parentTitle: "Context inheritance",
    workspacePath: "/repo/worktree",
    messages: [
      { role: "user", text: "Initial goal marker: inherited-marker-71" },
      { role: "assistant", text: "I am working on the parent task." },
    ],
  });

  assert.include(prompt, "Initial goal marker: inherited-marker-71");
  assert.include(prompt, "Write child-proof.txt containing inherited-marker-71.");
  assert.include(prompt, "Parent thread ID: thread:multitask:context-parent");
  assert.include(prompt, "Parent workspace: /repo/worktree");
});

it("defers user multitask completion until the parent settles", () => {
  assert.equal(DelegatedTaskService.completionWakeForLaunch({}), "settled_only");
  assert.equal(DelegatedTaskService.completionWakeForLaunch({ createdBy: "agent" }), "always");
  assert.equal(
    DelegatedTaskService.completionWakeForLaunch({
      createdBy: "user",
      completionWake: "always",
    }),
    "always",
  );
});

it("derives user task titles from the original draft instead of the context preamble", () => {
  assert.equal(
    DelegatedTaskService.titleForLaunch({ text: "Inspect the failing parser" }),
    "Inspect the failing parser",
  );
  assert.equal(
    DelegatedTaskService.titleForLaunch({
      createdBy: "user",
      text: "Inspect the failing parser",
      title: "Parser investigation",
    }),
    "Parser investigation",
  );
  assert.isUndefined(
    DelegatedTaskService.titleForLaunch({
      createdBy: "agent",
      text: "Inspect the failing parser",
    }),
  );
});

it.effect("replays an accepted launch after its parent turn ends", () =>
  Effect.gen(function* () {
    const commandId = CommandId.make("command:multitask:lost-response");
    const parentThreadId = ThreadId.make("thread:multitask:parent");
    const childThreadId = IdAllocator.derive.delegatedTaskThread({ commandId });
    const taskId = IdAllocator.derive.delegatedTaskNode({ commandId });
    const childRunId = RunId.make("run:multitask:child");
    const instanceId = ProviderInstanceId.make("codex");
    const prepared = yield* Ref.make<ReadonlyArray<RunId>>([]);
    const now = yield* DateTime.now;
    const configLayer = ServerConfig.layerTest(process.cwd(), "delegated-task-service-test").pipe(
      Layer.provide(NodeServices.layer),
    );

    const testLayer = DelegatedTaskService.layer.pipe(
      Layer.provide(IdAllocator.layer),
      Layer.provide(NodeServices.layer),
      Layer.provide(configLayer),
      Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(
        Layer.mock(CommandReceiptStore.CommandReceiptStoreV2)({
          getByCommandId: () =>
            Effect.succeed(
              Option.some({
                commandId,
                threadId: parentThreadId,
                commandType: "delegated_task.request",
                acceptedAt: now,
                resultSequence: 41,
                status: "accepted",
                error: null,
              }),
            ),
        }),
      ),
      Layer.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadProjection: (threadId) => {
            assert.equal(threadId, childThreadId);
            const projection = idleThreadProjection(liveThreadShell(childThreadId));
            const run = {
              id: childRunId,
              threadId: childThreadId,
              ordinal: 1,
              providerInstanceId: instanceId,
              modelSelection: { instanceId, model: "gpt-5.4" },
              providerThreadId: null,
              userMessageId: MessageId.make("message:multitask:child"),
              rootNodeId: null,
              activeAttemptId: null,
              status: "preparing",
              requestedAt: now,
              startedAt: null,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
              delegatedTaskId: taskId,
              workspacePreparation: { type: "worktree", baseRef: "original-sha" },
            } satisfies OrchestrationV2Run;
            return Effect.succeed({
              ...projection,
              thread: { ...projection.thread, projectId: ProjectId.make("project:multitask") },
              runs: [run],
            });
          },
        }),
      ),
      Layer.provide(
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          prepareRun: ({ runId }) => Ref.update(prepared, (runs) => [...runs, runId]),
        }),
      ),
    );

    yield* Effect.gen(function* () {
      const service = yield* DelegatedTaskService.DelegatedTaskService;
      const result = yield* service.launch({
        commandId,
        parentThreadId,
        text: "The retry body may differ because the original command is already committed.",
        attachments: [],
      });

      assert.deepEqual(result, { taskId, childThreadId, sequence: 41 });
      assert.deepEqual(yield* Ref.get(prepared), [childRunId]);
    }).pipe(Effect.provide(testLayer));
  }),
);
