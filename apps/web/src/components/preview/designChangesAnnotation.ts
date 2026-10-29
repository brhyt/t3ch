import type { BrowserDesignResult, PreviewAnnotationPayload } from "@t3tools/contracts";

export function designChangesLabel(snapshot: Pick<BrowserDesignResult, "changes" | "notes">) {
  const edits = snapshot.changes.length;
  const notes = snapshot.notes.length;
  return `${edits} ${edits === 1 ? "edit" : "edits"} · ${notes} ${notes === 1 ? "note" : "notes"}`;
}

export function designChangesAnnotation(
  id: string,
  pageUrl: string,
  snapshot: BrowserDesignResult,
): PreviewAnnotationPayload {
  return {
    id,
    pageUrl,
    pageTitle: designChangesLabel(snapshot),
    createdAt: new Date().toISOString(),
    comment: (
      (snapshot.changes.length
        ? "These source changes were already applied directly by the user in Design mode. Read the current files before continuing; do not repeat these edits.\n"
        : "") +
      snapshot.changes
        .map(
          (change) =>
            `${change.relativePath} · ${change.selector} · ${change.property}: ${JSON.stringify(change.previousValue).slice(0, 300)} → ${JSON.stringify(change.value).slice(0, 300)}`,
        )
        .join("\n") +
      (snapshot.notes.length
        ? "\nPending instructions for the agent:\n" +
          snapshot.notes.map((note) => `${note.pageUrl}: ${note.comment}`).join("\n")
        : "")
    ).slice(0, 7900),
    elements: [],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot: snapshot.notes.findLast((note) => note.screenshot)?.screenshot ?? null,
  };
}
