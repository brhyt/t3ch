import { describe, expect, it } from "vite-plus/test";
import { OrchestrationMessageContext, type BrowserDesignResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  formatComposerContextReference,
  projectComposerContextForProvider,
} from "@t3tools/shared/composerContextReferences";
import { previewAnnotationContextRecord } from "~/lib/composerContextRecords";
import { designChangesAnnotation } from "./designChangesAnnotation";

const decodeContext = Schema.decodeUnknownSync(OrchestrationMessageContext);

describe("Design mode message context", () => {
  it("delivers applied source changes and pending instructions through the existing message context", () => {
    const state: BrowserDesignResult = {
      canUndo: true,
      canRedo: false,
      history: [],
      contextVersion: "version",
      changes: [
        {
          relativePath: "src/Hero.tsx",
          selector: "h1",
          property: "textContent",
          previousValue: "Old",
          value: "New",
        },
      ],
      notes: [
        { id: "note", pageUrl: "http://localhost:3000", comment: "Make the heading responsive" },
      ],
    };
    const annotation = designChangesAnnotation("design-changes", "http://localhost:3000", state);
    const record = previewAnnotationContextRecord(annotation);
    const text = formatComposerContextReference(record);
    const context = decodeContext({
      version: 1,
      records: [record],
    });
    const prompt = projectComposerContextForProvider({ text, records: context.records });
    expect(prompt).toContain("already applied directly by the user");
    expect(prompt).toContain("do not repeat these edits");
    expect(prompt).toContain("src/Hero.tsx");
    expect(prompt).toContain('"Old" → "New"');
    expect(prompt).toContain("Make the heading responsive");
    expect(record.styleChanges).toEqual([]);
    expect(annotation.pageTitle).toBe("1 edit · 1 note");
  });
});
