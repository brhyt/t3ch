// @effect-diagnostics nodeBuiltinImport:off - Match the source revision produced by the Vite plugin.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as DesignChanges from "./DesignChanges.ts";

const dependencies = WorkspaceEntries.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
);
const layer = DesignChanges.layer.pipe(
  Layer.provideMerge(dependencies),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-design-changes-" })),
  Layer.provideMerge(NodeServices.layer),
);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-design-workspace-" });
  const file = path.join(cwd, "View.tsx");
  const initial = "export const View = () => <h1>Hello world</h1>;\n";
  yield* fs.writeFileString(file, initial);
  const service = yield* DesignChanges.DesignChanges;
  const scope = { cwd, threadId: "design-test" };
  const target = {
    tagName: "h1",
    text: "Hello world",
    selector: "h1",
    pageUrl: "http://localhost:3000",
    sourceFile: "View.tsx",
  };
  const selection = yield* service.inspect(scope, target);
  return { fs, path, file, initial, service, scope, target, selection };
});
const encodeHistoryScope = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeRecoveryPatch = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      relativePath: Schema.String,
      before: Schema.String,
      after: Schema.String,
      property: Schema.Literal("textContent"),
    }),
  ),
);

it.layer(layer, { excludeTestServices: true })("DesignChanges", (it) => {
  it.effect(
    "edits mapped dynamic JSX, rejects stale mappings, and persists reversible context",
    () =>
      Effect.gen(function* () {
        const { fs, file, service, scope, target } = yield* fixture;
        const initial =
          'const View = () => <section><h1>{preview ? "Preview" : "Make it a date."}</h1><h1>{label}</h1></section>;';
        yield* fs.writeFileString(file, initial);
        const mapped = {
          ...target,
          text: "Make it a date.",
          sourceIndex: 1,
          sourceRevision: NodeCrypto.createHash("sha256").update(initial).digest("hex"),
        };
        const selection = yield* service.inspect(scope, mapped);
        expect(selection.source).toContain('preview ? "Preview"');
        const next = yield* service.apply(scope, {
          id: "mapped",
          selection,
          property: "fontSize",
          previousValue: "32px",
          value: "42px",
        });
        expect(yield* fs.readFileString(file)).toContain(
          '<h1 style={{ fontSize: "42px" }}>{preview ? "Preview" : "Make it a date."}</h1>',
        );
        const stale = yield* service.inspect(scope, mapped).pipe(Effect.result);
        expect(stale._tag).toBe("Failure");
        expect((yield* service.snapshot(scope)).changes[0]).toMatchObject({
          property: "fontSize",
          value: "42px",
        });
        yield* service.step(scope, "undo");
        expect(yield* fs.readFileString(file)).toBe(initial);
        yield* service.step(scope, "redo");
        expect(yield* fs.readFileString(file)).toContain(next.source);
      }),
  );
  it.effect("recovers interrupted saves before and after the source replacement", () =>
    Effect.gen(function* () {
      for (const phase of ["before", "after"]) {
        const { fs, path, file, initial, service, scope, selection } = yield* fixture;
        const after = yield* service.apply(scope, {
          id: "crash",
          selection,
          property: "textContent",
          previousValue: "Hello world",
          value: "Recovered",
        });
        const config = yield* ServerConfig.ServerConfig;
        const digest = yield* Effect.promise(() =>
          crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(encodeHistoryScope([path.resolve(scope.cwd), scope.threadId])),
          ),
        );
        const hash = Buffer.from(digest).toString("hex");
        const journal = path.join(config.stateDir, "design-history", hash + ".json");
        const persisted = yield* fs.readFileString(journal);
        const patch = encodeRecoveryPatch({
          relativePath: "View.tsx",
          before: selection.source,
          after: after.source,
          property: "textContent",
        });
        yield* fs.writeFileString(journal, persisted.replace('"patch":null', '"patch":' + patch));
        if (phase === "before") yield* fs.writeFileString(file, initial);
        const state = yield* service.snapshot(scope);
        expect(state.canUndo).toBe(true);
        expect(yield* fs.readFileString(file)).toBe(
          'export const View = () => <h1>{"Recovered"}</h1>;\n',
        );
        yield* service.step(scope, "undo");
        expect(yield* fs.readFileString(file)).toBe(initial);
      }
    }),
  );
  it.effect("saves source and restores it one step at a time, including redo", () =>
    Effect.gen(function* () {
      const { fs, file, initial, service, scope, selection } = yield* fixture;
      const next = yield* service.apply(scope, {
        id: "text",
        selection,
        property: "textContent",
        previousValue: "Hello world",
        value: "Updated title",
      });
      yield* service.apply(scope, {
        id: "padding",
        selection: next,
        property: "padding",
        previousValue: "0px",
        value: "24px",
      });
      expect(yield* fs.readFileString(file)).toBe(
        'export const View = () => <h1 style={{ paddingTop: "24px" , paddingRight: "24px" , paddingBottom: "24px" , paddingLeft: "24px" }}>{"Updated title"}</h1>;\n',
      );
      expect((yield* service.snapshot(scope)).changes).toHaveLength(2);
      yield* service.step(scope, "undo");
      expect(yield* fs.readFileString(file)).toBe(
        'export const View = () => <h1>{"Updated title"}</h1>;\n',
      );
      yield* service.step(scope, "undo");
      expect(yield* fs.readFileString(file)).toBe(initial);
      expect((yield* service.snapshot(scope)).changes).toEqual([]);
      expect((yield* service.snapshot(scope)).canRedo).toBe(true);
      yield* service.step(scope, "redo");
      expect(yield* fs.readFileString(file)).toContain('{"Updated title"}');
    }),
  );
  it.effect("preserves unrelated edits during undo and rejects edits to the same target", () =>
    Effect.gen(function* () {
      const { fs, file, initial, service, scope, selection } = yield* fixture;
      yield* service.apply(scope, {
        id: "change",
        selection,
        property: "color",
        previousValue: "black",
        value: "red",
      });
      const changed = yield* fs.readFileString(file);
      yield* fs.writeFileString(file, "// agent work\n" + changed);
      yield* service.step(scope, "undo");
      expect(yield* fs.readFileString(file)).toBe("// agent work\n" + initial);
      yield* fs.writeFileString(file, initial.replace("Hello world", "Agent title"));
      const result = yield* service.step(scope, "redo").pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(yield* fs.readFileString(file)).toBe(initial.replace("Hello world", "Agent title"));
      expect((yield* service.snapshot(scope)).canRedo).toBe(true);
    }),
  );
  it.effect("persists spatial note evidence and removes notes without changing source", () =>
    Effect.gen(function* () {
      const { service, scope, fs, file } = yield* fixture;
      const before = yield* fs.readFileString(file);
      const note = {
        id: "spatial-note",
        pageUrl: "http://localhost:3000",
        comment: "Align this card",
        target: { selector: "h1", tagName: "h1", text: "Hello world", relativePath: "View.tsx" },
        screenshot: {
          dataUrl: "data:image/jpeg;base64,dGVzdA==",
          width: 640,
          height: 400,
          cropRect: { x: 0, y: 0, width: 640, height: 400 },
        },
      };
      yield* service.note(scope, note);
      expect((yield* service.snapshot(scope)).notes).toEqual([note]);
      yield* service.removeNote(scope, note.id);
      yield* service.removeNote(scope, note.id);
      expect((yield* service.snapshot(scope)).notes).toEqual([]);
      expect(yield* fs.readFileString(file)).toBe(before);
    }),
  );
  it.effect("reconstructs history in a new service and handles repeated requests once", () =>
    Effect.gen(function* () {
      const { service, scope, selection } = yield* fixture;
      const edit = {
        id: "same-request",
        selection,
        property: "textContent" as const,
        previousValue: "Hello world",
        value: "New",
      };
      yield* service.apply(scope, edit);
      yield* service.apply(scope, edit);
      const restarted = yield* Effect.gen(function* () {
        const fresh = yield* DesignChanges.DesignChanges;
        return yield* fresh.snapshot(scope);
      }).pipe(Effect.provide(DesignChanges.layer));
      expect(restarted.history).toHaveLength(1);
      expect(restarted.canUndo).toBe(true);
      expect(restarted.changes[0]?.value).toBe("New");
    }),
  );
  it.effect("reduces repeated edits to their net change and discards a redo branch", () =>
    Effect.gen(function* () {
      const { service, scope, selection } = yield* fixture;
      const next = yield* service.apply(scope, {
        id: "one",
        selection,
        property: "textContent",
        previousValue: "Hello world",
        value: "Second",
      });
      yield* service.apply(scope, {
        id: "two",
        selection: next,
        property: "textContent",
        previousValue: "Second",
        value: "Hello world",
      });
      expect((yield* service.snapshot(scope)).changes).toEqual([]);
      yield* service.step(scope, "undo");
      yield* service.apply(scope, {
        id: "three",
        selection: next,
        property: "textContent",
        previousValue: "Second",
        value: "Third",
      });
      const state = yield* service.snapshot(scope);
      expect(state.canRedo).toBe(false);
      expect(state.changes).toEqual([
        {
          relativePath: "View.tsx",
          selector: "h1",
          property: "textContent",
          previousValue: "Hello world",
          value: "Third",
        },
      ]);
    }),
  );
  it.effect("refuses ambiguous source and paths outside the workspace", () =>
    Effect.gen(function* () {
      const { fs, file, initial, service, scope, target } = yield* fixture;
      yield* fs.writeFileString(file, initial + "export const Other = () => <h1>Hello world</h1>;");
      const ambiguous = yield* service.inspect(scope, target).pipe(Effect.result);
      expect(ambiguous._tag === "Failure" && ambiguous.failure.reason).toBe("ambiguous");
      const escaped = yield* service
        .inspect(scope, { ...target, sourceFile: "../View.tsx" })
        .pipe(Effect.result);
      expect(escaped._tag).toBe("Failure");
    }),
  );
  it.effect(
    "keeps unrelated attributes and style properties in the same element when undoing",
    () =>
      Effect.gen(function* () {
        const { fs, file, service, scope, selection } = yield* fixture;
        yield* service.apply(scope, {
          id: "color",
          selection,
          property: "color",
          previousValue: "black",
          value: "red",
        });
        yield* fs.writeFileString(
          file,
          'export const View = () => <h1 id="agent" style={{ color: "red", padding: 12 }}>Hello world</h1>;\n',
        );
        yield* service.step(scope, "undo");
        const contents = yield* fs.readFileString(file);
        expect(contents).toContain('id="agent"');
        expect(contents).toContain("padding: 12");
        expect(contents).not.toContain("color:");
      }),
  );
  it.effect("rejects a repeated edit after undo instead of pretending it saved", () =>
    Effect.gen(function* () {
      const { service, scope, selection } = yield* fixture;
      const edit = {
        id: "retry",
        selection,
        property: "textContent" as const,
        previousValue: "Hello world",
        value: "Changed",
      };
      yield* service.apply(scope, edit);
      yield* service.step(scope, "undo");
      const result = yield* service.apply(scope, edit).pipe(Effect.result);
      expect(result._tag === "Failure" && result.failure.reason).toBe("conflict");
      expect((yield* service.snapshot(scope)).canRedo).toBe(true);
    }),
  );
  it.effect("retains notes and reports only changes made since the previous message", () =>
    Effect.gen(function* () {
      const { service, scope, selection } = yield* fixture;
      const next = yield* service.apply(scope, {
        id: "first",
        selection,
        property: "textContent",
        previousValue: "Hello world",
        value: "Second",
      });
      yield* service.note(scope, {
        id: "note",
        comment: "Make this responsive",
        pageUrl: "http://localhost:3000",
      });
      const pending = yield* service.snapshot(scope);
      expect(pending.notes[0]?.comment).toBe("Make this responsive");
      yield* service.acknowledge(scope, "stale-version");
      expect((yield* service.snapshot(scope)).notes).toHaveLength(1);
      yield* service.acknowledge(scope, pending.contextVersion);
      expect((yield* service.snapshot(scope)).changes).toEqual([]);
      expect((yield* service.snapshot(scope)).notes).toEqual([]);
      yield* service.apply(scope, {
        id: "second",
        selection: next,
        property: "textContent",
        previousValue: "Second",
        value: "Third",
      });
      expect((yield* service.snapshot(scope)).changes[0]).toMatchObject({
        previousValue: "Second",
        value: "Third",
      });
      yield* service.step(scope, "undo");
      expect((yield* service.snapshot(scope)).changes).toEqual([]);
      yield* service.step(scope, "undo");
      expect((yield* service.snapshot(scope)).changes[0]).toMatchObject({
        previousValue: "Second",
        value: "Hello world",
      });
    }),
  );
});
