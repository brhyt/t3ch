import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeAssert from "node:assert/strict";
import type * as CodexClient from "effect-codex-app-server/client";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import {
  CodexSettings,
  ThreadId,
  ProviderSessionId,
  ProjectId,
  RunId,
  RunAttemptId,
  NodeId,
  MessageId,
  ProviderTurnId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";

import * as ServerConfig from "../../config.ts";
import { checkCodexProviderStatus } from "../../provider/CodexProvider.ts";
import { AgentScope, agentScopeCommand } from "@t3tools/shared/AgentScope";

const testHome = process.env.T3CODE_HOME!;
const workspace = process.env.RESTRICTED_PROOF_WORKSPACE!;
NodeAssert.ok(workspace);
const settings = Schema.decodeSync(CodexSettings)({
  binaryPath: process.env.RESTRICTED_PROOF_BINARY,
  launchArgs:
    '-c model_provider="fixture" -c model_providers.fixture.name="fixture" -c model_providers.fixture.base_url="http://127.0.0.1:18888/v1" -c model_providers.fixture.wire_api="responses" -c model_providers.fixture.requires_openai_auth=false',
});
const CODEX_TEST_MODEL_SELECTION = {
  instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
  model: "fixture",
};
const CODEX_TEST_RUNTIME_POLICY = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: workspace,
});
function makeCodexTestAppThread(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: "Codex continuation test",
    providerInstanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
    modelSelection: CODEX_TEST_MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: input.providerThread.id,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function makeCodexTestTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly attemptId: RunAttemptId;
  readonly text: string;
}): ProviderAdapter.ProviderAdapterV2TurnInput {
  return {
    appThread: makeCodexTestAppThread(input),
    threadId: input.threadId,
    runId: RunId.make(`run-${input.attemptId}`),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: input.attemptId,
    rootNodeId: NodeId.make(`node-${input.attemptId}`),
    providerThread: input.providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(`message-${input.attemptId}`),
      text: input.text,
      attachments: [],
    },
    modelSelection: CODEX_TEST_MODEL_SELECTION,
    runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
  };
}

const base = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
);
const killScope = process.env.RESTRICTED_PROOF_KILL_SCOPE === "1";
let scopeIndex = 0;
const scopeLayer = Layer.succeed(AgentScope, {
  wrap: Effect.fn("proof.wrap")((input) =>
    Effect.sync(() =>
      agentScopeCommand({
        ...input,
        scope: {
          systemdRun: "/usr/bin/systemd-run",
          slice: "app.slice",
          unit: `t3-restricted-proof-${process.pid}-${scopeIndex++}.scope`,
          runtimeDir: `/run/user/${process.getuid!()}`,
          options: ["--property=TimeoutStopSec=10s", "--property=Delegate=yes"],
        },
      }),
    ),
  ),
  oomKilled: Effect.fn("proof.oomKilled")(() => Effect.succeed(false)),
  clear: Effect.fn("proof.clear")(() => Effect.void),
});
const factory = CodexAdapterV2.layerAppServerClientFactory.pipe(
  Layer.provide(Layer.mergeAll(base, scopeLayer)),
);
await Effect.runPromise(
  Effect.gen(function* () {
    const before = yield* Clock.currentTimeMillis;
    const status = yield* checkCodexProviderStatus(settings, undefined, {});
    yield* Effect.log({
      stage: "probe",
      elapsedMs: (yield* Clock.currentTimeMillis) - before,
      status: status.status,
      auth: status.auth,
      version: status.version,
      models: status.models.length,
    });
    NodeAssert.equal(status.installed, true);
    NodeAssert.equal(status.version, "0.171.0");
    NodeAssert.ok(status.models.length > 0);
    let client: CodexClient.CodexAppServerClient["Service"];
    const realFactory = yield* CodexAdapterV2.CodexAppServerClientFactory;
    const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
      instanceId: CODEX_TEST_MODEL_SELECTION.instanceId,
      settings,
      environment: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: testHome },
      clientFactory: {
        open: (input) =>
          realFactory.open(input).pipe(
            Effect.tap((value) =>
              Effect.sync(() => {
                client = value;
              }),
            ),
          ),
      },
      crypto: yield* Crypto.Crypto,
      fileSystem: yield* FileSystem.FileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* ServerConfig.ServerConfig,
    });
    const threadId = ThreadId.make("restricted-proof");
    const first = yield* Effect.gen(function* () {
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("proof-one"),
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      yield* Effect.log({ stage: "ensureThread" });
      if (killScope) {
        const killer = yield* (yield* ChildProcessSpawner.ChildProcessSpawner).spawn(
          ChildProcess.make("systemctl", [
            "--user",
            "kill",
            "--signal=SIGKILL",
            "--kill-whom=all",
            `t3-restricted-proof-${process.pid}-0.scope`,
          ]),
        );
        NodeAssert.equal(yield* killer.exitCode, 0);
        const exited = yield* client!
          .request("thread/list", {})
          .pipe(Effect.result, Effect.timeout("20 seconds"));
        NodeAssert.ok(Result.isFailure(exited));
        yield* Effect.log({ stage: "scope_kill_observed" });
        return providerThread;
      }
      const command = yield* client!.request("command/exec", {
        command: ["sh", "-c", "printf isolated > proof.txt; cat proof.txt"],
        cwd: workspace,
        sandboxPolicy: { type: "dangerFullAccess" },
      });
      NodeAssert.equal(command.exitCode, 0);
      NodeAssert.equal(command.stdout, "isolated");
      NodeAssert.equal(
        yield* (yield* FileSystem.FileSystem).readFileString(workspace + "/proof.txt"),
        "isolated",
      );

      const ready = yield* Deferred.make<void>();
      yield* client!.raw.notifications.pipe(
        Stream.runForEach((event) =>
          event.method === "command/exec/outputDelta"
            ? Deferred.succeed(ready, undefined)
            : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* client!
        .request("command/exec", {
          command: ["python3", "fixture.py"],
          cwd: workspace,
          sandboxPolicy: { type: "dangerFullAccess" },
          processId: "fixture",
          streamStdoutStderr: true,
          timeoutMs: 60000,
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(ready).pipe(Effect.timeout("10 seconds"));
      const done = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event.type === "turn.terminal") {
              NodeAssert.equal(event.status, "completed");
              yield* Deferred.succeed(done, undefined);
            }
          }),
        ),
        Effect.forkScoped,
      );
      yield* runtime.startTurn(
        makeCodexTestTurnInput({
          threadId,
          providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("first"),
          text: "synthetic fixture",
        }),
      );
      yield* Deferred.await(done).pipe(Effect.timeout("20 seconds"));
      yield* Effect.log({ stage: "completed" });
      yield* client!.request("command/exec/terminate", { processId: "fixture" });
      return providerThread;
    }).pipe(Effect.scoped);
    if (killScope) return;
    yield* Effect.gen(function* () {
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("proof-two"),
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      const resumed = yield* runtime.resumeThread({
        providerThread: first,
        threadId,
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      NodeAssert.equal(resumed.nativeThreadRef?.nativeId, first.nativeThreadRef?.nativeId);
      yield* Effect.log({ stage: "resumed" });
      const running = yield* Deferred.make<ProviderTurnId>();
      const cancelled = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event.type === "provider_turn.updated" && event.providerTurn.status === "running")
              yield* Deferred.succeed(running, event.providerTurn.id);
            if (event.type === "turn.terminal") {
              NodeAssert.equal(event.status, "interrupted");
              yield* Deferred.succeed(cancelled, undefined);
            }
          }),
        ),
        Effect.forkScoped,
      );
      yield* runtime.startTurn(
        makeCodexTestTurnInput({
          threadId,
          providerThread: resumed,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("cancel"),
          text: "synthetic cancellation",
        }),
      );
      const providerTurnId = yield* Deferred.await(running).pipe(Effect.timeout("20 seconds"));
      yield* runtime.interruptTurn({ providerThread: resumed, providerTurnId });
      yield* Deferred.await(cancelled).pipe(Effect.timeout("20 seconds"));
      yield* Effect.log({ stage: "cancelled" });
    }).pipe(Effect.scoped);
    yield* Effect.gen(function* () {
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("proof-mismatch"),
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      const denied = yield* runtime
        .ensureThread({
          threadId,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy: { ...CODEX_TEST_RUNTIME_POLICY, cwd: "/tmp" },
        })
        .pipe(Effect.result);
      NodeAssert.ok(Result.isFailure(denied));
      yield* Effect.log({ stage: "workspace_mismatch_denied" });
    }).pipe(Effect.scoped);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        base,
        factory,
        ServerConfig.layerTest(workspace, process.env.T3CODE_HOME!).pipe(Layer.provide(base)),
      ),
    ),
  ),
);
