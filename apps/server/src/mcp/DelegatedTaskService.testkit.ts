import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { OrchestrationV2MultitaskError } from "@t3tools/contracts";

import * as DelegatedTaskService from "../orchestration-v2/DelegatedTaskService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export const layerFromThreadManagement = Layer.effect(
  DelegatedTaskService.DelegatedTaskService,
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const projects = yield* ProjectService.ProjectService;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    return DelegatedTaskService.DelegatedTaskService.of({
      launch: (input) =>
        Effect.gen(function* () {
          if (
            input.parentRunId === undefined ||
            input.parentNodeId === undefined ||
            input.modelSelection === undefined ||
            input.runtimeMode === undefined ||
            input.interactionMode === undefined
          ) {
            return yield* Effect.die("The MCP test adapter requires resolved launch input.");
          }
          let workspaceStrategy:
            | {
                readonly type: "worktree";
                readonly baseRef: string;
                readonly startFromOrigin: false;
              }
            | undefined;
          const isAcceptedRetry = yield* threads.hasReceipt(input.commandId);
          if (input.isolation === "worktree" && !isAcceptedRetry) {
            const parent = yield* threads.getThreadProjection(input.parentThreadId);
            const project = Option.getOrThrow(yield* projects.getById(parent.thread.projectId));
            const base = yield* git
              .resolveCommit({
                cwd: parent.thread.worktreePath ?? project.workspaceRoot,
                revision: "HEAD",
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationV2MultitaskError({
                      commandId: input.commandId,
                      parentThreadId: input.parentThreadId,
                      reason: "worktree-unavailable",
                      message: "Unable to resolve the parent checkout commit.",
                      cause,
                    }),
                ),
              );
            workspaceStrategy = {
              type: "worktree",
              baseRef: base.commitSha,
              startFromOrigin: false,
            };
          }
          const result = yield* threads.dispatch({
            type: "delegated_task.request",
            createdBy: input.createdBy ?? "agent",
            creationSource: input.creationSource ?? "mcp",
            commandId: input.commandId,
            parentThreadId: input.parentThreadId,
            parentRunId: input.parentRunId,
            parentNodeId: input.parentNodeId,
            task: input.text,
            ...(input.title === undefined ? {} : { title: input.title }),
            attachments: input.attachments,
            ...(input.context === undefined ? {} : { context: input.context }),
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            ...(workspaceStrategy === undefined ? {} : { workspaceStrategy }),
            completionWake: input.completionWake ?? "always",
          });
          const task = result.storedEvents.find(
            (stored) =>
              stored.event.type === "subagent.updated" &&
              stored.event.payload.origin === "app_owned" &&
              stored.event.payload.childThreadId !== null,
          );
          if (
            task?.event.type !== "subagent.updated" ||
            task.event.payload.childThreadId === null
          ) {
            return yield* Effect.die("Delegated task test dispatch did not return a child task.");
          }
          const childThreadId = task.event.payload.childThreadId;
          const childRun = result.storedEvents.find(
            (stored) =>
              stored.event.type === "run.created" && stored.event.threadId === childThreadId,
          );
          if (
            childRun?.event.type === "run.created" &&
            childRun.event.payload.workspacePreparation !== undefined
          ) {
            yield* threadLaunch.prepareRun({
              commandId: input.commandId,
              threadId: childThreadId,
              runId: childRun.event.payload.id,
            });
          }
          return {
            taskId: task.event.payload.id,
            childThreadId,
            sequence: result.sequence,
          };
        }).pipe(
          Effect.mapError((cause) =>
            Schema.is(OrchestrationV2MultitaskError)(cause)
              ? cause
              : new OrchestrationV2MultitaskError({
                  commandId: input.commandId,
                  parentThreadId: input.parentThreadId,
                  reason: "dispatch-failed",
                  message: "The multitask test dispatch failed.",
                  cause,
                }),
          ),
        ),
    });
  }),
);
