// @effect-diagnostics nodeBuiltinImport:off - Atomic source replacement and write-ahead recovery use the host filesystem.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import {
  BrowserDesignError,
  DesignChange,
  DesignEdit,
  DesignSelection,
  DesignProperty,
  DesignNote,
  type DesignSnapshot,
  type DesignTarget,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import { editDesignSource, findDesignSources, applyDesignPatch } from "./designSource.ts";

const Entry = Schema.Struct({ ...DesignEdit.fields, after: Schema.String });
const Note = DesignNote;
const History = Schema.Struct({
  entries: Schema.Array(Entry),
  cursor: Schema.Int,
  notes: Schema.optionalKey(Schema.Array(Note)),
  reported: Schema.optionalKey(Schema.Array(DesignChange)),
});
type History = typeof History.Type;
const Journal = Schema.Struct({
  history: History,
  patch: Schema.NullOr(
    Schema.Struct({
      relativePath: Schema.String,
      before: Schema.String,
      after: Schema.String,
      property: DesignProperty,
      sourceIndex: Schema.optionalKey(Schema.Int),
    }),
  ),
});
const decodeJournal = Schema.decodeUnknownSync(Schema.fromJsonString(Journal));
const isDesignError = Schema.is(BrowserDesignError);
type Scope = { readonly cwd: string; readonly threadId: string };

export class DesignChanges extends Context.Service<
  DesignChanges,
  {
    readonly inspect: (
      scope: Scope,
      target: DesignTarget,
    ) => Effect.Effect<DesignSelection, BrowserDesignError>;
    readonly apply: (
      scope: Scope,
      edit: DesignEdit,
    ) => Effect.Effect<DesignSelection, BrowserDesignError>;
    readonly step: (
      scope: Scope,
      direction: "undo" | "redo",
    ) => Effect.Effect<
      { sourceFile: string; sourceRevision: string } | undefined,
      BrowserDesignError
    >;
    readonly snapshot: (scope: Scope) => Effect.Effect<DesignSnapshot, BrowserDesignError>;
    readonly note: (
      scope: Scope,
      note: typeof Note.Type,
    ) => Effect.Effect<void, BrowserDesignError>;
    readonly removeNote: (scope: Scope, noteId: string) => Effect.Effect<void, BrowserDesignError>;
    readonly acknowledge: (
      scope: Scope,
      version: string,
    ) => Effect.Effect<void, BrowserDesignError>;
  }
>()("t3/preview/DesignChanges") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const entries = yield* WorkspaceEntries.WorkspaceEntries;
  const lock = yield* Semaphore.make(1);
  const directory = NodePath.join(config.stateDir, "design-history");
  const attempt = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        isDesignError(cause) ? cause : new BrowserDesignError({ reason: "io", cause }),
    });

  const historyPath = (scope: Scope) =>
    NodePath.join(
      directory,
      NodeCrypto.createHash("sha256")
        .update(JSON.stringify([NodePath.resolve(scope.cwd), scope.threadId]))
        .digest("hex") + ".json",
    );
  const safePath = async (scope: Scope, relativePath: string) => {
    const root = await NodeFSP.realpath(scope.cwd);
    const requested = NodePath.resolve(root, relativePath);
    const candidate = await NodeFSP.realpath(requested);
    const relative = NodePath.relative(root, candidate);
    if (
      NodePath.isAbsolute(relativePath) ||
      relative === ".." ||
      relative.startsWith(`..${NodePath.sep}`) ||
      NodePath.isAbsolute(relative)
    )
      throw new BrowserDesignError({ reason: "outside-workspace" });
    if (
      relative
        .split(NodePath.sep)
        .some((part) => ["node_modules", ".git", ".t3", "dist", "build", ".next"].includes(part))
    )
      throw new BrowserDesignError({ reason: "outside-workspace" });
    if (!/\.[cm]?[jt]sx?$/.test(candidate) || (await NodeFSP.stat(candidate)).size > 1024 * 1024)
      throw new BrowserDesignError({ reason: "unsupported" });
    return candidate;
  };
  const atomicWrite = async (file: string, contents: string) => {
    const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
    const stat = await NodeFSP.stat(file).catch(() => null);
    try {
      await NodeFSP.writeFile(temporary, contents, { mode: stat?.mode ?? 0o600, flag: "wx" });
      await NodeFSP.rename(temporary, file);
    } finally {
      await NodeFSP.rm(temporary, { force: true });
    }
  };
  const save = async (scope: Scope, journal: typeof Journal.Type) => {
    await NodeFSP.mkdir(directory, { recursive: true });
    await atomicWrite(historyPath(scope), JSON.stringify(journal));
  };
  const load = async (scope: Scope): Promise<History> => {
    let raw: string;
    try {
      raw = await NodeFSP.readFile(historyPath(scope), "utf8");
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        return { entries: [], cursor: 0 };
      throw cause;
    }
    const journal = decodeJournal(raw);
    if (!journal.patch) return journal.history;
    const patch = journal.patch;
    const file = await safePath(scope, patch.relativePath);
    const current = await NodeFSP.readFile(file, "utf8");
    try {
      const next = applyDesignPatch(
        current,
        patch.before,
        patch.after,
        patch.property,
        patch.sourceIndex,
      );
      await atomicWrite(file, next);
    } catch {
      applyDesignPatch(current, patch.after, patch.before, patch.property, patch.sourceIndex);
    }
    await save(scope, { history: journal.history, patch: null });
    return journal.history;
  };
  const commit = async (
    scope: Scope,
    history: History,
    patch: NonNullable<typeof Journal.Type.patch>,
    expectedRevision?: string,
  ) => {
    const file = await safePath(scope, patch.relativePath);
    const current = await NodeFSP.readFile(file, "utf8");
    if (
      expectedRevision &&
      NodeCrypto.createHash("sha256").update(current).digest("hex") !== expectedRevision
    )
      throw new BrowserDesignError({ reason: "conflict" });
    const next = applyDesignPatch(
      current,
      patch.before,
      patch.after,
      patch.property,
      patch.sourceIndex,
    );
    await save(scope, { history, patch });
    // Other editors do not share our lock. Recheck before replacing their file.
    if ((await NodeFSP.readFile(file, "utf8")) !== current) {
      // Retain the prior cursor on conflict; never recover this failed edit later.
      throw new BrowserDesignError({ reason: "conflict" });
    }
    await atomicWrite(file, next);
    await save(scope, { history, patch: null });
    return NodeCrypto.createHash("sha256").update(next).digest("hex");
  };

  const inspect: DesignChanges["Service"]["inspect"] = Effect.fn("DesignChanges.inspect")(
    function* (scope, target) {
      let candidates: readonly string[];
      if (target.sourceFile) {
        let name =
          target.sourceFile
            .replace(/^file:\/\//, "")
            .replace(/^.*\/@fs\//, "/")
            .split("?")[0] ?? "";
        if (NodePath.isAbsolute(name)) name = NodePath.relative(scope.cwd, name);
        candidates = [name];
      } else {
        const query = (target.text.match(/[\p{L}\p{N}_-]+/gu) ?? [])
          .slice(0, 3)
          .sort((a, b) => b.length - a.length)[0]
          ?.slice(0, 120);
        if (!query) return yield* new BrowserDesignError({ reason: "unsupported" });
        const result = yield* entries
          .searchContents({
            cwd: scope.cwd,
            query,
            limit: 200,
            caseSensitive: true,
            wholeWord: false,
            useRegex: false,
          })
          .pipe(Effect.mapError((cause) => new BrowserDesignError({ reason: "io", cause })));
        if (result.truncated) return yield* new BrowserDesignError({ reason: "ambiguous" });
        candidates = [...new Set(result.matches.map((match) => match.path))].filter((file) =>
          /\.[cm]?[jt]sx?$/.test(file),
        );
      }
      return yield* attempt(async () => {
        const matches: DesignSelection[] = [];
        for (const relativePath of candidates) {
          const file = await safePath(scope, relativePath);
          const contents = await NodeFSP.readFile(file, "utf8");
          if (
            target.sourceIndex !== undefined &&
            (!target.sourceRevision ||
              NodeCrypto.createHash("sha256").update(contents).digest("hex") !==
                target.sourceRevision)
          )
            throw new BrowserDesignError({ reason: "conflict" });
          for (const source of findDesignSources(contents, target))
            matches.push({ target, relativePath, source });
          if (matches.length > 1) throw new BrowserDesignError({ reason: "ambiguous" });
        }
        const match = matches[0];
        if (!match) throw new BrowserDesignError({ reason: "unsupported" });
        return match;
      });
    },
  );

  const apply: DesignChanges["Service"]["apply"] = (scope, edit) =>
    lock.withPermit(
      attempt(async () => {
        const history = await load(scope);
        const duplicate = history.entries.find((entry) => entry.id === edit.id);
        if (duplicate) {
          if (
            history.entries.indexOf(duplicate) >= history.cursor ||
            duplicate.property !== edit.property ||
            duplicate.value !== edit.value ||
            duplicate.selection.source !== edit.selection.source
          )
            throw new BrowserDesignError({ reason: "conflict" });
          return {
            ...duplicate.selection,
            source: duplicate.after,
            target: {
              ...duplicate.selection.target,
              ...(duplicate.property === "textContent" ? { text: duplicate.value } : {}),
            },
          };
        }
        if (history.entries.length >= 100) throw new BrowserDesignError({ reason: "history-full" });
        const after = editDesignSource(edit.selection.source, edit.property, edit.value);
        if (after === edit.selection.source) return edit.selection;
        const entry = { ...edit, after };
        const next = {
          ...history,
          entries: [...history.entries.slice(0, history.cursor), entry],
          cursor: history.cursor + 1,
        };
        let sourceRevision: string;
        try {
          sourceRevision = await commit(
            scope,
            next,
            {
              relativePath: edit.selection.relativePath,
              before: edit.selection.source,
              after,
              property: edit.property,
              ...(edit.selection.target.sourceIndex !== undefined
                ? { sourceIndex: edit.selection.target.sourceIndex }
                : {}),
            },
            edit.selection.target.sourceIndex !== undefined
              ? edit.selection.target.sourceRevision
              : undefined,
          );
        } catch (cause) {
          if (isDesignError(cause) && cause.reason === "conflict")
            await save(scope, { history, patch: null });
          throw cause;
        }
        return {
          ...edit.selection,
          source: after,
          target: {
            ...edit.selection.target,
            ...(edit.selection.target.sourceIndex !== undefined ? { sourceRevision } : {}),
            ...(edit.property === "textContent" ? { text: edit.value } : {}),
          },
        };
      }),
    );

  const step: DesignChanges["Service"]["step"] = (scope, direction) =>
    lock
      .withPermit(
        attempt(async () => {
          const history = await load(scope);
          const index = direction === "undo" ? history.cursor - 1 : history.cursor;
          const entry = history.entries[index];
          if (!entry) return;
          const undo = direction === "undo";
          try {
            const sourceRevision = await commit(
              scope,
              { ...history, cursor: history.cursor + (undo ? -1 : 1) },
              {
                relativePath: entry.selection.relativePath,
                property: entry.property,
                ...(entry.selection.target.sourceIndex !== undefined
                  ? { sourceIndex: entry.selection.target.sourceIndex }
                  : {}),
                before: undo ? entry.after : entry.selection.source,
                after: undo ? entry.selection.source : entry.after,
              },
            );
            return {
              sourceFile: NodePath.resolve(scope.cwd, entry.selection.relativePath),
              sourceRevision,
            };
          } catch (cause) {
            if (isDesignError(cause) && cause.reason === "conflict")
              await save(scope, { history, patch: null });
            throw cause;
          }
        }),
      )
      .pipe(Effect.tap(() => entries.refresh(scope.cwd)));
  const summarize = (history: History): DesignSnapshot => {
    const changes = new Map<string, typeof DesignChange.Type>();
    for (const entry of history.entries.slice(0, history.cursor)) {
      const key = JSON.stringify([
        entry.selection.relativePath,
        entry.selection.target.selector,
        entry.property,
      ]);
      const previous = changes.get(key);
      changes.set(key, {
        relativePath: entry.selection.relativePath,
        selector: entry.selection.target.selector,
        property: entry.property,
        previousValue: previous?.previousValue ?? entry.previousValue,
        value: entry.value,
      });
    }
    const reported = new Map(
      (history.reported ?? []).map((change) => [
        JSON.stringify([change.relativePath, change.selector, change.property]),
        change,
      ]),
    );
    const pending = new Map(changes);
    for (const [key, previous] of reported) {
      const current = changes.get(key);
      pending.set(key, {
        ...(current ?? previous),
        previousValue: previous.value,
        value: current?.value ?? previous.previousValue,
      });
    }
    const net = [...pending.values()].filter((change) => change.previousValue !== change.value);
    const notes = history.notes ?? [];
    return {
      canUndo: history.cursor > 0,
      canRedo: history.cursor < history.entries.length,
      history: history.entries.map((entry, index) => ({
        id: entry.id,
        label: `${entry.selection.target.tagName} · ${entry.property === "textContent" ? "Text" : entry.property} → ${entry.value.slice(0, 60)}`,
        applied: index < history.cursor,
      })),
      changes: net,
      notes,
      contextVersion: NodeCrypto.createHash("sha256")
        .update(JSON.stringify([net, notes]))
        .digest("hex"),
    };
  };
  const snapshot: DesignChanges["Service"]["snapshot"] = (scope) =>
    lock.withPermit(attempt(async () => summarize(await load(scope))));
  const removeNote: DesignChanges["Service"]["removeNote"] = (scope, noteId) =>
    lock.withPermit(
      attempt(async () => {
        const history = await load(scope);
        await save(scope, {
          history: {
            ...history,
            notes: (history.notes ?? []).filter((note) => note.id !== noteId),
          },
          patch: null,
        });
      }),
    );
  const note: DesignChanges["Service"]["note"] = (scope, note) =>
    lock.withPermit(
      attempt(async () => {
        const history = await load(scope);
        if ((history.notes ?? []).some((entry) => entry.id === note.id)) return;
        if ((history.notes ?? []).length >= 50)
          throw new BrowserDesignError({ reason: "history-full" });
        await save(scope, {
          history: { ...history, notes: [...(history.notes ?? []), note] },
          patch: null,
        });
      }),
    );
  const acknowledge: DesignChanges["Service"]["acknowledge"] = (scope, version) =>
    lock.withPermit(
      attempt(async () => {
        const history = await load(scope);
        const state = summarize(history);
        if (state.contextVersion !== version) return;
        const full = summarize({ ...history, reported: [] });
        await save(scope, {
          history: { ...history, reported: full.changes, notes: [] },
          patch: null,
        });
      }),
    );
  return DesignChanges.of({ removeNote, inspect, apply, step, snapshot, note, acknowledge });
});
export const layer = Layer.effect(DesignChanges, make);
