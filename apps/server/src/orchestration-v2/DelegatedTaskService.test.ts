import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type ChatAttachment,
  CommandId,
  EnvironmentId,
  GitCommandError,
  MessageId,
  NodeId,
  OrchestrationV2MultitaskError,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as DelegatedTaskService from "./DelegatedTaskService.ts";
import { OrchestratorCommandRejectedError } from "./Orchestrator.ts";
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
      Layer.provide(Layer.mock(DocumentText.DocumentText)({})),
      Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
      Layer.provide(
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:here")),
        }),
      ),
      Layer.provide(
        Layer.mock(CommandReceiptStore.CommandReceiptStoreV2)({
          getByCommandId: () =>
            Effect.succeedSome({
              commandId,
              threadId: parentThreadId,
              commandType: "delegated_task.request",
              acceptedAt: now,
              resultSequence: 41,
              status: "accepted",
              error: null,
            }),
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
    }).pipe(
      Effect.provide(Layer.merge(testLayer, Layer.mock(RemoteDelegation.RemoteDelegation)({}))),
    );
  }),
);

const isMultitaskError = Schema.is(OrchestrationV2MultitaskError);

describeLaunchTargets();

function describeLaunchTargets() {
  const hereId = EnvironmentId.make("environment:here");
  const otherId = EnvironmentId.make("environment:other");
  const parentThreadId = ThreadId.make("thread:multitask:target-parent");
  const parentRunId = RunId.make("run:multitask:target-parent");
  const rootNodeId = NodeId.make("node:multitask:target-root");
  const codex = ProviderInstanceId.make("codex");
  const claude = ProviderInstanceId.make("claude");
  const projectRoot = "/repo/project";

  const provider = (
    instanceId: ProviderInstanceId,
    models: ReadonlyArray<string>,
    enabled = true,
  ): ServerProvider => ({
    instanceId,
    driver: ProviderDriverKind.make(instanceId),
    enabled,
    installed: enabled,
    version: enabled ? "test" : null,
    status: enabled ? "ready" : "disabled",
    auth: { status: enabled ? "authenticated" : "unknown" },
    checkedAt: "2026-09-13T00:00:00.000Z",
    models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
  });

  const harness = (options: {
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly enabledForProject?: boolean;
    readonly parentWorktreePath?: string | null;
  }) =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const delegated = yield* Ref.make<
        ReadonlyArray<{
          readonly scope: McpThreadInvocationScope;
          readonly input: Parameters<RemoteDelegation.RemoteDelegation["Service"]["delegate"]>[1];
        }>
      >([]);
      const now = yield* DateTime.now;
      const shell = liveThreadShell(parentThreadId);
      const projection = idleThreadProjection(shell);
      const run = {
        id: parentRunId,
        threadId: parentThreadId,
        ordinal: 1,
        providerInstanceId: codex,
        modelSelection: { instanceId: codex, model: "gpt-5" },
        providerThreadId: null,
        userMessageId: MessageId.make("message:multitask:target-parent"),
        rootNodeId,
        activeAttemptId: null,
        status: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      } satisfies OrchestrationV2Run;
      const parent = {
        ...projection,
        thread: {
          ...projection.thread,
          worktreePath: options.parentWorktreePath ?? null,
        },
        runs: [run],
        nodes: [{ id: rootNodeId, runId: parentRunId, threadId: parentThreadId } as never],
        subagents: [
          {
            id: NodeId.make("node:multitask:remote-task"),
            remoteChild: {
              environmentId: otherId,
              threadId: ThreadId.make("thread:there"),
              label: "Other",
            },
          } as never,
        ],
      };
      const configLayer = ServerConfig.layerTest(process.cwd(), "delegated-task-target-test").pipe(
        Layer.provide(NodeServices.layer),
      );
      const layer = DelegatedTaskService.layer.pipe(
        Layer.provide(IdAllocator.layer),
        Layer.provide(NodeServices.layer),
        Layer.provide(configLayer),
        Layer.provide(Layer.mock(DocumentText.DocumentText)({})),
        Layer.provide(
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeedSome({
                id: shell.projectId,
                title: "Project",
                workspaceRoot: projectRoot,
              } as never),
          }),
        ),
        Layer.provide(
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            resolveCommit: ({ cwd, revision }) =>
              cwd === projectRoot && revision !== "HEAD"
                ? Effect.fail(
                    new GitCommandError({
                      operation: "test",
                      command: "git",
                      cwd,
                      detail: "missing",
                    }),
                  )
                : Effect.succeed({ commitSha: "parent-sha" }),
          }),
        ),
        Layer.provide(
          Layer.mock(CommandReceiptStore.CommandReceiptStoreV2)({
            getByCommandId: () => Effect.succeedNone,
          }),
        ),
        Layer.provide(
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed(options.providers),
            refreshInstance: () => Effect.succeed(options.providers),
          }),
        ),
        Layer.provide(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(hereId),
          }),
        ),
        Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
        Layer.provide(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(parent as never),
            isProviderInstanceEnabledForProject: () =>
              Effect.succeed(options.enabledForProject ?? true),
            getThreadEventSequence: () => Effect.succeed(55),
            // Recording the command is enough; the orchestrator's own tests cover the rest.
            dispatch: (command) =>
              Ref.update(dispatched, (all) => [...all, command]).pipe(
                Effect.andThen(
                  Effect.fail(
                    new OrchestratorCommandRejectedError({
                      commandId: command.commandId,
                      commandType: command.type,
                    }),
                  ),
                ),
              ),
          }),
        ),
      );
      const remoteLayer = Layer.mock(RemoteDelegation.RemoteDelegation)({
        delegate: (scope, input) =>
          Ref.update(delegated, (all) => [...all, { scope, input }]).pipe(
            Effect.as({ taskId: NodeId.make("node:multitask:remote-task") }),
          ),
      });
      const launch = (input: Partial<DelegatedTaskService.DelegatedTaskLaunchInput>) =>
        DelegatedTaskService.DelegatedTaskService.pipe(
          Effect.flatMap((service) =>
            service.launch({
              commandId: CommandId.make("command:multitask:target"),
              parentThreadId,
              text: "Investigate the flaky parser test.",
              attachments: [],
              ...input,
            }),
          ),
          Effect.provide(Layer.merge(layer, remoteLayer)),
          Effect.exit,
        );
      return { launch, dispatched, delegated };
    });

  const failureReason = <A>(exit: Exit.Exit<A, unknown>): string | undefined => {
    if (Exit.isSuccess(exit)) return undefined;
    const error = Cause.squash(exit.cause);
    return isMultitaskError(error) ? error.reason : undefined;
  };

  it.effect("runs a local multitask with the target's provider and model", () =>
    Effect.gen(function* () {
      const { launch, dispatched } = yield* harness({
        providers: [provider(codex, ["gpt-5"]), provider(claude, ["claude-opus", "claude-sonnet"])],
      });
      yield* launch({
        modelSelection: { instanceId: codex, model: "gpt-5" },
        target: { environmentId: hereId, providerInstanceId: claude, model: "claude-sonnet" },
      });
      const [command] = yield* Ref.get(dispatched);
      assert.deepInclude(command, {
        type: "delegated_task.request",
        modelSelection: { instanceId: claude, model: "claude-sonnet" },
        workspaceStrategy: { type: "worktree", baseRef: "parent-sha", startFromOrigin: false },
      });
    }),
  );

  it.effect("refuses a disabled provider or an unknown model before dispatching", () =>
    Effect.gen(function* () {
      const disabled = yield* harness({
        providers: [provider(codex, ["gpt-5"]), provider(claude, ["claude-opus"], false)],
      });
      const disabledExit = yield* disabled.launch({ target: { providerInstanceId: claude } });
      assert.equal(failureReason(disabledExit), "provider-unavailable");

      const offForProject = yield* harness({
        providers: [provider(codex, ["gpt-5"])],
        enabledForProject: false,
      });
      assert.equal(
        failureReason(yield* offForProject.launch({ target: { model: "gpt-5" } })),
        "provider-unavailable",
      );

      const unknownModel = yield* harness({ providers: [provider(codex, ["gpt-5"])] });
      assert.equal(
        failureReason(yield* unknownModel.launch({ target: { model: "gpt-9" } })),
        "model-unavailable",
      );
      assert.deepEqual(yield* Ref.get(disabled.dispatched), []);
      assert.deepEqual(yield* Ref.get(offForProject.dispatched), []);
      assert.deepEqual(yield* Ref.get(unknownModel.dispatched), []);
    }),
  );

  it.effect("refuses a worktree whose project root lacks the parent's commit", () =>
    Effect.gen(function* () {
      const { launch, dispatched } = yield* harness({
        providers: [provider(codex, ["gpt-5"])],
        parentWorktreePath: "/scratch/other-repo",
      });
      assert.equal(failureReason(yield* launch({})), "worktree-unavailable");
      assert.deepEqual(yield* Ref.get(dispatched), []);
    }),
  );

  it.effect("hands a linked-environment target to RemoteDelegation as the parent's run", () =>
    Effect.gen(function* () {
      const { launch, dispatched, delegated } = yield* harness({ providers: [] });
      const exit = yield* launch({
        modelSelection: { instanceId: codex, model: "gpt-5" },
        runtimeMode: "auto-accept-edits",
        target: { environmentId: otherId },
      });
      assert.isTrue(Exit.isSuccess(exit));
      if (Exit.isSuccess(exit)) {
        assert.deepEqual(exit.value, {
          taskId: NodeId.make("node:multitask:remote-task"),
          childThreadId: ThreadId.make("thread:there"),
          childEnvironmentId: otherId,
          sequence: 55,
        });
      }
      const [call] = yield* Ref.get(delegated);
      assert.isDefined(call);
      assert.equal(call?.scope.environmentId, hereId);
      assert.deepEqual(call?.scope.thread, {
        threadId: parentThreadId,
        providerSessionId: "multitask:command:multitask:target",
        providerInstanceId: codex,
      });
      assert.deepInclude(call?.input, {
        target: { environmentId: otherId, providerInstanceId: codex, model: "gpt-5" },
        clientRequestId: "command:multitask:target",
        mode: "async",
        runtimeMode: "auto-accept-edits",
        title: "Investigate the flaky parser test.",
      });
      assert.isUndefined(call?.input.isolation);
      assert.isUndefined(call?.input.role);
      assert.include(call?.input.task ?? "", "Your task:\nInvestigate the flaky parser test.");
      assert.deepEqual(yield* Ref.get(dispatched), []);
    }),
  );

  it.effect("refuses attachments for a linked-environment target", () =>
    Effect.gen(function* () {
      const { launch, delegated } = yield* harness({ providers: [] });
      const exit = yield* launch({
        attachments: [{ id: "attachment-1" } as unknown as ChatAttachment],
        target: { environmentId: otherId },
      });
      assert.equal(failureReason(exit), "attachments-remote-unsupported");
      assert.deepEqual(yield* Ref.get(delegated), []);
    }),
  );
}
