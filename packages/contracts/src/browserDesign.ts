import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PreviewTabId } from "./preview.ts";

const Text = Schema.String.check(Schema.isMaxLength(32_768));
export const DesignProperty = Schema.Literals([
  "textContent",
  "color",
  "backgroundColor",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "padding",
  "margin",
  "gap",
  "borderRadius",
  "textAlign",
  "fontFamily",
  "fontStyle",
  "letterSpacing",
  "textDecoration",
  "textTransform",
  "display",
  "flexDirection",
  "justifyContent",
  "alignItems",
  "alignSelf",
  "flexGrow",
  "flexShrink",
  "order",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "marginTop",
  "marginRight",
  "marginBottom",
  "marginLeft",
  "width",
  "height",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "overflow",
  "boxSizing",
  "borderWidth",
  "borderStyle",
  "borderColor",
  "objectFit",
  "objectPosition",
]);
export type DesignProperty = typeof DesignProperty.Type;

export const DesignTarget = Schema.Struct({
  tagName: TrimmedNonEmptyString,
  text: Text,
  selector: Text,
  pageUrl: Text,
  sourceFile: Schema.NullOr(Text),
  sourceIndex: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  sourceRevision: Schema.optionalKey(Text),
});
export type DesignTarget = typeof DesignTarget.Type;

export const DesignSelection = Schema.Struct({
  target: DesignTarget,
  relativePath: TrimmedNonEmptyString,
  source: Text,
});
export type DesignSelection = typeof DesignSelection.Type;

export const DesignEdit = Schema.Struct({
  id: TrimmedNonEmptyString,
  selection: DesignSelection,
  property: DesignProperty,
  previousValue: Text,
  value: Text,
});
export type DesignEdit = typeof DesignEdit.Type;

export const DesignNoteScreenshot = Schema.Struct({
  dataUrl: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  cropRect: Schema.Struct({
    x: Schema.Number,
    y: Schema.Number,
    width: Schema.Number,
    height: Schema.Number,
  }),
});
export const DesignNote = Schema.Struct({
  id: Schema.String,
  comment: Text,
  pageUrl: Text,
  target: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        selector: Text,
        tagName: Text,
        text: Text,
        relativePath: Schema.NullOr(Text),
      }),
    ),
  ),
  screenshot: Schema.optionalKey(DesignNoteScreenshot),
});
export const DesignPageRequest = Schema.Union([
  Schema.TaggedStruct("ready", { id: Schema.String }),
  Schema.TaggedStruct("removeNote", { id: Schema.String, noteId: Schema.String }),
  Schema.TaggedStruct("select", { id: Schema.String, target: DesignTarget }),
  Schema.TaggedStruct("edit", {
    id: Schema.String,
    selectionId: Schema.String,
    property: DesignProperty,
    previousValue: Text,
    value: Text,
  }),
  Schema.TaggedStruct("note", { ...DesignNote.fields }),
  Schema.TaggedStruct("history", {
    id: Schema.String,
    direction: Schema.Literals(["undo", "redo"]),
  }),
]);
export type DesignPageRequest = typeof DesignPageRequest.Type;

export type DesignPageCommand =
  | { readonly kind: "start"; readonly mode?: "style" | "annotate" }
  | { readonly kind: "poll" | "stop" | "flush" | "capture" }
  | { readonly kind: "refresh"; readonly sourceFile: string; readonly sourceRevision: string }
  | { readonly kind: "present"; readonly state: DesignSnapshot }
  | {
      readonly kind: "ack";
      readonly id: string;
      readonly selection: {
        readonly id: string;
        readonly relativePath: string;
        readonly canEditText?: boolean;
      } | null;
      readonly error: string | null;
    };

export const DesignChange = Schema.Struct({
  relativePath: Schema.String,
  selector: Schema.String,
  property: DesignProperty,
  previousValue: Text,
  value: Text,
});
export type DesignChange = typeof DesignChange.Type;

export const DesignSnapshot = Schema.Struct({
  canUndo: Schema.Boolean,
  canRedo: Schema.Boolean,
  history: Schema.Array(
    Schema.Struct({ id: Schema.String, label: Schema.String, applied: Schema.Boolean }),
  ),
  changes: Schema.Array(DesignChange),
  notes: Schema.Array(DesignNote),
  contextVersion: Schema.String,
});
export type DesignSnapshot = typeof DesignSnapshot.Type;

export const BrowserDesignInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  clientId: TrimmedNonEmptyString,
  operation: Schema.Literals(["start", "sync", "stop", "undo", "redo", "acknowledge"]),
  mode: Schema.optional(Schema.Literals(["style", "annotate"])),
  contextVersion: Schema.optional(Schema.String),
});
export type BrowserDesignInput = typeof BrowserDesignInput.Type;
export const BrowserDesignResult = Schema.Struct({
  ...DesignSnapshot.fields,
});
export type BrowserDesignResult = typeof BrowserDesignResult.Type;

export class BrowserDesignError extends Schema.TaggedError<BrowserDesignError>()(
  "BrowserDesignError",
  {
    reason: Schema.Literals([
      "unsupported",
      "ambiguous",
      "conflict",
      "outside-workspace",
      "io",
      "browser",
      "history-full",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unsupported":
        return "This element could not be connected to editable JSX. Connect the project to Designer or annotate it for the agent.";
      case "ambiguous":
        return "More than one source element matches. Annotate this change for the agent instead.";
      case "conflict":
        return "The source changed since this edit. Select the element again before editing.";
      case "outside-workspace":
        return "Design edits must stay inside this thread's workspace.";
      case "io":
        return "The design change could not be saved. Check the workspace and retry.";
      case "browser":
        return "Design mode could not reach this browser tab. Reload the page and try again.";
      case "history-full":
        return "This design history is full. Start a new thread to make more design edits.";
    }
  }
}
