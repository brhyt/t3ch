import {
  projectComposerContextForProvider,
  remapComposerContextAttachments,
} from "@t3tools/shared/composerContextReferences";
import {
  OrchestrationV2MultitaskError,
  type ChatAttachment,
  type CommandId,
  type ModelSelection,
  type NodeId,
  type OrchestrationMessageContext,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2MultitaskResult,
  type ProviderInteractionMode,
  type RunId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as AttachmentClaims from "./AttachmentClaims.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import { exceededDispatchModeLimit } from "./DispatchModeLimit.ts";
import type { OrchestratorV2Error } from "./Orchestrator.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

export interface DelegatedTaskLaunchInput {
  readonly commandId: CommandId;
  readonly parentThreadId: ThreadId;
  readonly parentRunId?: RunId | undefined;
  readonly parentNodeId?: NodeId | undefined;
  readonly text: string;
  readonly title?: string | undefined;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext | undefined;
  readonly modelSelection?: ModelSelection | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
  readonly interactionMode?: ProviderInteractionMode | undefined;
  readonly isolation?: "worktree" | "shared" | undefined;
  readonly completionWake?: "always" | "settled_only" | undefined;
  readonly createdBy?: OrchestrationV2Actor | undefined;
  readonly creationSource?: OrchestrationV2CreationSource | undefined;
}

export class DelegatedTaskService extends Context.Service<
  DelegatedTaskService,
  {
    readonly launch: (
      input: DelegatedTaskLaunchInput,
    ) => Effect.Effect<OrchestrationV2MultitaskResult, OrchestrationV2MultitaskError>;
  }
>()("t3/orchestration-v2/DelegatedTaskService") {}

const makeError = (
  input: Pick<DelegatedTaskLaunchInput, "commandId" | "parentThreadId">,
  reason: OrchestrationV2MultitaskError["reason"],
  cause?: unknown,
) => {
  const message = {
    "parent-not-active": "Multitask requires an active parent turn.",
    "mode-escalation": "Multitask cannot use broader permissions than its parent thread.",
    "project-not-found": "The parent thread's project could not be found.",
    "worktree-unavailable": "A worktree could not be prepared from the parent checkout.",
    "dispatch-failed": "The multitask could not be started.",
    "result-missing": "The multitask started without a tracked child thread.",
  }[reason];
  return new OrchestrationV2MultitaskError({
    commandId: input.commandId,
    parentThreadId: input.parentThreadId,
    reason,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
};

const PARENT_CONTEXT_MESSAGE_LIMIT = 12;
const PARENT_CONTEXT_CHARACTER_LIMIT = 16_000;

export function composeUserMultitaskPrompt(input: {
  readonly task: string;
  readonly parentThreadId: ThreadId;
  readonly parentTitle: string;
  readonly workspacePath: string;
  readonly messages: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "role" | "text" | "context">
  >;
}): string {
  const eligible = input.messages.flatMap((message) => {
    if (message.role === "system" || message.text.trim().length === 0) return [];
    return [
      {
        role: message.role,
        text: projectComposerContextForProvider({
          text: message.text,
          records: message.context?.records ?? [],
        }),
      },
    ];
  });
  const firstUser = eligible.find((message) => message.role === "user");
  const tail = eligible.slice(-PARENT_CONTEXT_MESSAGE_LIMIT);
  const candidates =
    firstUser !== undefined && !tail.includes(firstUser) ? [firstUser, ...tail.slice(1)] : tail;
  const selected: typeof candidates = [];
  let characters = 0;
  for (const message of candidates) {
    const remaining = PARENT_CONTEXT_CHARACTER_LIMIT - characters;
    if (remaining <= 0) break;
    const text = message.text.length <= remaining ? message.text : message.text.slice(0, remaining);
    selected.push({ role: message.role, text });
    characters += text.length;
  }
  const conversation = selected
    .map((message) => `<${message.role}>\n${message.text}\n</${message.role}>`)
    .join("\n\n");
  return [
    "You are a tracked child task working alongside the parent thread.",
    "The current task below governs your work. Treat the parent conversation as background context.",
    `Parent thread ID: ${input.parentThreadId}`,
    `Parent thread: ${input.parentTitle}`,
    `Parent workspace: ${input.workspacePath}`,
    conversation.length === 0 ? undefined : `Recent parent conversation:\n${conversation}`,
    `Your task:\n${input.task}`,
  ]
    .filter((part) => part !== undefined)
    .join("\n\n");
}

export function completionWakeForLaunch(
  input: Pick<DelegatedTaskLaunchInput, "completionWake" | "createdBy">,
): "always" | "settled_only" {
  return (
    input.completionWake ?? ((input.createdBy ?? "user") === "user" ? "settled_only" : "always")
  );
}

export function titleForLaunch(
  input: Pick<DelegatedTaskLaunchInput, "createdBy" | "text" | "title">,
): string | undefined {
  return input.title ?? ((input.createdBy ?? "user") === "user" ? input.text : undefined);
}

const dispatchWasNotAccepted = (
  error:
    | OrchestratorV2Error
    | ThreadManagementService.ThreadManagementProviderInstanceDisabledError,
) => {
  switch (error._tag) {
    case "OrchestratorCommandRejectedError":
    case "OrchestratorProjectionError":
    case "OrchestratorProviderAdapterError":
    case "OrchestratorCommandPreviouslyRejectedError":
    case "OrchestratorCommandIdConflictError":
    case "OrchestratorSubagentThreadReadOnlyError":
    case "OrchestratorThreadAboveModeLimitError":
    case "ThreadManagementProviderInstanceDisabledError":
      return true;
    default:
      return false;
  }
};

const make = Effect.gen(function* () {
  const ids = yield* IdAllocator.IdAllocatorV2;
  const attachmentContext = yield* Effect.context<
    FileSystem.FileSystem | ServerConfig.ServerConfig
  >();
  const projects = yield* ProjectService.ProjectService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;

  const launch: DelegatedTaskService["Service"]["launch"] = Effect.fn(
    "DelegatedTaskService.launch",
  )(function* (input) {
    const childThreadId = ids.derive.delegatedTaskThread({ commandId: input.commandId });
    const taskId = ids.derive.delegatedTaskNode({ commandId: input.commandId });
    const existingReceipt = yield* receipts
      .getByCommandId(input.commandId)
      .pipe(Effect.mapError((cause) => makeError(input, "dispatch-failed", cause)));
    if (Option.isSome(existingReceipt)) {
      const receipt = existingReceipt.value;
      if (
        receipt.status !== "accepted" ||
        receipt.threadId !== input.parentThreadId ||
        receipt.commandType !== "delegated_task.request"
      ) {
        return yield* makeError(input, "dispatch-failed", receipt.error ?? undefined);
      }
      const child = yield* threads
        .getThreadProjection(childThreadId)
        .pipe(Effect.mapError((cause) => makeError(input, "result-missing", cause)));
      const childRun = child.runs.find((run) => run.delegatedTaskId === taskId);
      if (childRun === undefined) return yield* makeError(input, "result-missing");
      if (childRun.workspacePreparation !== undefined) {
        yield* threadLaunch.prepareRun({
          commandId: input.commandId,
          threadId: childThreadId,
          runId: childRun.id,
        });
      }
      return { taskId, childThreadId, sequence: receipt.resultSequence };
    }

    const userLaunch = (input.createdBy ?? "user") === "user";
    const parent = yield* threads
      .getThreadRecords(
        input.parentThreadId,
        userLaunch ? ["runs", "nodes", "messages"] : ["runs", "nodes"],
      )
      .pipe(Effect.mapError((cause) => makeError(input, "parent-not-active", cause)));
    const activeRun =
      input.parentRunId === undefined
        ? ThreadManagementService.latestActiveRun(parent)
        : parent.runs.find(
            (candidate) =>
              candidate.id === input.parentRunId && ThreadManagementService.isActiveRun(candidate),
          );
    const parentNodeId = input.parentNodeId ?? activeRun?.rootNodeId ?? undefined;
    const parentNode = parent.nodes.find(
      (candidate) => candidate.id === parentNodeId && candidate.runId === activeRun?.id,
    );
    if (activeRun === undefined || parentNodeId === undefined || parentNode === undefined) {
      return yield* makeError(input, "parent-not-active");
    }

    const runtimeMode = input.runtimeMode ?? parent.thread.runtimeMode;
    const interactionMode = input.interactionMode ?? parent.thread.interactionMode;
    if (
      exceededDispatchModeLimit(
        {
          runtimeMode: parent.thread.runtimeMode,
          interactionMode: parent.thread.interactionMode,
        },
        { runtimeMode, interactionMode },
      ) !== undefined
    ) {
      return yield* makeError(input, "mode-escalation");
    }

    const modelSelection = input.modelSelection ?? parent.thread.modelSelection;
    const needsProject = userLaunch || (input.isolation ?? "worktree") === "worktree";
    const project = needsProject
      ? Option.getOrUndefined(
          yield* projects
            .getById(parent.thread.projectId)
            .pipe(Effect.mapError((cause) => makeError(input, "project-not-found", cause))),
        )
      : undefined;
    if (needsProject && project === undefined) return yield* makeError(input, "project-not-found");
    const task = userLaunch
      ? composeUserMultitaskPrompt({
          task: input.text,
          parentThreadId: input.parentThreadId,
          parentTitle: parent.thread.title,
          workspacePath:
            parent.thread.worktreePath ?? project?.workspaceRoot ?? "Project workspace",
          messages: parent.messages,
        })
      : input.text;
    let workspaceStrategy:
      | { readonly type: "worktree"; readonly baseRef: string; readonly startFromOrigin: false }
      | undefined;
    if ((input.isolation ?? "worktree") === "worktree") {
      if (project === undefined) return yield* makeError(input, "project-not-found");
      const base = yield* git
        .resolveCommit({
          cwd: parent.thread.worktreePath ?? project.workspaceRoot,
          revision: "HEAD",
        })
        .pipe(Effect.mapError((cause) => makeError(input, "worktree-unavailable", cause)));
      workspaceStrategy = { type: "worktree", baseRef: base.commitSha, startFromOrigin: false };
    }

    const claimed = yield* AttachmentClaims.claimPendingAttachments({
      threadId: childThreadId,
      attachments: input.attachments,
    }).pipe(
      Effect.provide(attachmentContext),
      Effect.mapError((cause) => makeError(input, "dispatch-failed", cause)),
    );
    const context =
      input.context === undefined
        ? undefined
        : remapComposerContextAttachments(input.context, input.attachments, claimed.attachments);
    const launchTitle = titleForLaunch(input);
    const result = yield* threads
      .dispatch({
        type: "delegated_task.request",
        createdBy: input.createdBy ?? "user",
        creationSource: input.creationSource ?? "web",
        commandId: input.commandId,
        parentThreadId: input.parentThreadId,
        parentRunId: activeRun.id,
        parentNodeId,
        task,
        ...(launchTitle === undefined ? {} : { title: launchTitle }),
        attachments: claimed.attachments,
        ...(context === undefined ? {} : { context }),
        modelSelection,
        runtimeMode,
        interactionMode,
        ...(workspaceStrategy === undefined ? {} : { workspaceStrategy }),
        completionWake: completionWakeForLaunch(input),
      })
      .pipe(
        Effect.tapError((error) =>
          dispatchWasNotAccepted(error)
            ? AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths).pipe(
                Effect.provide(attachmentContext),
              )
            : Effect.void,
        ),
        Effect.mapError((cause) => makeError(input, "dispatch-failed", cause)),
      );
    const taskEvent = result.storedEvents.find(
      (stored) =>
        stored.event.type === "subagent.updated" && stored.event.payload.origin === "app_owned",
    );
    if (
      taskEvent?.event.type !== "subagent.updated" ||
      taskEvent.event.payload.childThreadId === null
    ) {
      return yield* makeError(input, "result-missing");
    }
    const launchedTaskId = taskEvent.event.payload.id;
    const launchedChildThreadId = taskEvent.event.payload.childThreadId;
    const childRunEvent = result.storedEvents.find(
      (stored) =>
        stored.event.type === "run.created" && stored.event.threadId === launchedChildThreadId,
    );
    if (
      childRunEvent?.event.type === "run.created" &&
      childRunEvent.event.payload.workspacePreparation !== undefined
    ) {
      yield* threadLaunch.prepareRun({
        commandId: input.commandId,
        threadId: launchedChildThreadId,
        runId: childRunEvent.event.payload.id,
      });
    }
    return {
      taskId: launchedTaskId,
      childThreadId: launchedChildThreadId,
      sequence: result.sequence,
    } satisfies OrchestrationV2MultitaskResult;
  });

  return DelegatedTaskService.of({ launch });
});

export const layer = Layer.effect(DelegatedTaskService, make);
