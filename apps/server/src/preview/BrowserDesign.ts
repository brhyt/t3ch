import {
  BrowserDesignError,
  DesignPageRequest,
  DesignNoteScreenshot,
  type BrowserDesignInput,
  type BrowserDesignResult,
  type DesignSelection,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Option from "effect/Option";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as DesignChanges from "./DesignChanges.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import { canEditDesignText } from "./designSource.ts";

export class BrowserDesign extends Context.Service<
  BrowserDesign,
  {
    readonly execute: (
      input: BrowserDesignInput,
    ) => Effect.Effect<BrowserDesignResult, BrowserDesignError>;
  }
>()("t3/preview/BrowserDesign") {}

const decodeScreenshot = Schema.decodeUnknownOption(DesignNoteScreenshot);

const make = Effect.gen(function* () {
  const source = yield* DesignChanges.DesignChanges;
  const browser = yield* ServerBrowser.ServerBrowser;
  const lock = yield* Semaphore.make(1);
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const presented = new Map<string, string>();
  const owners = new Map<string, { clientId: string; touchedAt: number }>();
  const selections = new Map<string, { id: string; selection: DesignSelection }>();
  const decodeRequest = Schema.decodeUnknownEffect(Schema.NullOr(DesignPageRequest));
  const execute: BrowserDesign["Service"]["execute"] = (input) =>
    lock.withPermit(
      Effect.gen(function* () {
        const key = `${input.threadId}\0${input.tabId}`;
        const owner = owners.get(key);
        const now = yield* Clock.currentTimeMillis;
        if (
          owner &&
          owner.clientId !== input.clientId &&
          input.operation !== "start" &&
          now - owner.touchedAt < 30_000
        )
          return yield* new BrowserDesignError({ reason: "conflict" });
        owners.set(key, { clientId: input.clientId, touchedAt: now });
        const thread = yield* projections
          .getThreadShell(input.threadId)
          .pipe(Effect.mapError((cause) => new BrowserDesignError({ reason: "io", cause })));
        if (!thread) return yield* new BrowserDesignError({ reason: "unsupported" });
        const project = yield* projects
          .getShell(thread.projectId)
          .pipe(Effect.mapError((cause) => new BrowserDesignError({ reason: "io", cause })));
        if (Option.isNone(project)) return yield* new BrowserDesignError({ reason: "unsupported" });
        const scope = {
          threadId: input.threadId,
          cwd: thread.worktreePath ?? project.value.workspaceRoot,
        };
        if (input.operation === "acknowledge") {
          if (input.contextVersion) yield* source.acknowledge(scope, input.contextVersion);
          return yield* source.snapshot(scope);
        }
        const page = (command: Parameters<typeof browser.designPage>[0]["command"]) =>
          browser.designPage({ ...input, command });
        const raw = yield* page(
          input.operation === "start"
            ? { kind: "start", ...(input.mode ? { mode: input.mode } : {}) }
            : { kind: input.operation === "sync" ? "poll" : "flush" },
        );
        const request = yield* decodeRequest(raw).pipe(
          Effect.mapError((cause) => new BrowserDesignError({ reason: "browser", cause })),
        );
        if (request) {
          let selection: DesignSelection | null = null;
          let error: string | null = null;
          if (request._tag === "ready") presented.delete(key);
          else if (request._tag === "removeNote") {
            const result = yield* source.removeNote(scope, request.noteId).pipe(Effect.result);
            if (result._tag === "Failure") error = result.failure.message;
          } else if (request._tag === "note") {
            const capture = yield* page({ kind: "capture" }).pipe(Effect.result);
            const screenshot =
              capture._tag === "Success" ? decodeScreenshot(capture.success) : Option.none();
            const result = yield* source
              .note(scope, {
                ...request,
                ...(Option.isSome(screenshot) ? { screenshot: screenshot.value } : {}),
              })
              .pipe(Effect.result);
            if (result._tag === "Failure") error = result.failure.message;
          } else if (request._tag === "history") {
            const result = yield* source.step(scope, request.direction).pipe(Effect.result);
            if (result._tag === "Failure") error = result.failure.message;
            else if (result.success) {
              selections.delete(key);
              yield* page({ kind: "refresh", ...result.success });
              presented.delete(key);
            }
          } else {
            const current = selections.get(key);
            const result = yield* (
              request._tag === "select"
                ? source.inspect(scope, request.target)
                : current?.id === request.selectionId
                  ? source.apply(scope, { ...request, selection: current.selection })
                  : Effect.fail(new BrowserDesignError({ reason: "conflict" }))
            ).pipe(Effect.result);
            if (result._tag === "Success") {
              selection = result.success;
              selections.set(key, {
                id: request._tag === "select" ? request.id : request.selectionId,
                selection,
              });
            } else error = result.failure.message;
          }
          const selected = selections.get(key);
          yield* page({
            kind: "ack",
            id: request.id,
            selection:
              selection && selected
                ? {
                    id: selected.id,
                    relativePath: selection.relativePath,
                    canEditText: canEditDesignText(selection.source),
                  }
                : null,
            error,
          });
        }
        if (input.operation === "undo" || input.operation === "redo") {
          const restored = yield* source.step(scope, input.operation);
          if (restored) {
            selections.delete(key);
            yield* page({ kind: "refresh", ...restored });
          }
          presented.delete(key);
        }
        if (input.operation === "stop") {
          const stopped = yield* page({ kind: "stop" });
          if (stopped === false) return yield* new BrowserDesignError({ reason: "conflict" });
          owners.delete(key);
          selections.delete(key);
        }
        const snapshot = yield* source.snapshot(scope);
        const version = `${snapshot.contextVersion}:${snapshot.canUndo}:${snapshot.canRedo}`;
        if (
          input.operation !== "stop" &&
          (input.operation === "start" || presented.get(key) !== version)
        ) {
          yield* page({ kind: "present", state: snapshot });
          presented.set(key, version);
        }
        if (input.operation === "stop") presented.delete(key);
        return input.contextVersion === snapshot.contextVersion
          ? {
              ...snapshot,
              notes: snapshot.notes.map(({ screenshot: _screenshot, ...note }) => note),
            }
          : snapshot;
      }),
    );
  return BrowserDesign.of({ execute });
});
export const layer = Layer.effect(BrowserDesign, make);
