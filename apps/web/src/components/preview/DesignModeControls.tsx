import { designChangesAnnotation, designChangesLabel } from "./designChangesAnnotation";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthPreviewOperateScope,
  type BrowserDesignInput,
  type BrowserDesignResult,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Redo2, Undo2, Palette, MessageSquare } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dataUrlToFile } from "~/lib/imageCompression";
import { randomUUID } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useProject, useThreadShell } from "~/state/entities";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

export function DesignModeControls({
  threadRef: incomingThreadRef,
  tabId,
  pageUrl,
  disabled,
  hasControl,
  onActiveChange,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly pageUrl: string;
  readonly disabled: boolean;
  readonly hasControl: boolean;
  readonly onActiveChange: (active: boolean) => void;
}) {
  const threadRef = useMemo(
    () => ({
      environmentId: incomingThreadRef.environmentId,
      threadId: incomingThreadRef.threadId,
    }),
    [incomingThreadRef.environmentId, incomingThreadRef.threadId],
  );
  const thread = useThreadShell(threadRef);
  const project = useProject(
    thread ? { environmentId: threadRef.environmentId, projectId: thread.projectId } : null,
  );
  const cwd = thread?.worktreePath ?? project?.workspaceRoot;
  const canWrite = useAtomValue(previewEnvironment.design.permissionAtom(threadRef.environmentId));
  const canPreview = useEnvironmentScope(threadRef.environmentId, AuthPreviewOperateScope);
  const execute = useAtomCommand(previewEnvironment.design, { reportFailure: false });
  const key = `t3-design:${threadRef.environmentId}:${threadRef.threadId}:${tabId}`;
  const [clientId] = useState(() => {
    const existing = sessionStorage.getItem(`${key}:client`);
    if (existing) return existing;
    const id = randomUUID();
    sessionStorage.setItem(`${key}:client`, id);
    return id;
  });
  const initialMode = useRef<"style" | "annotate">("style");
  const [active, setActive] = useState(() => sessionStorage.getItem(key) === "active");
  const [snapshot, setSnapshot] = useState<BrowserDesignResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const mounted = useRef(true);
  const lastChanges = useRef<string | null>(null);
  const annotationId = "design-changes";
  const contextKey = `t3-design-context:${threadRef.environmentId}:${threadRef.threadId}`;
  const lastContextVersion = useRef(sessionStorage.getItem(contextKey));
  const seenNoteImages = useRef(new Set<string>());
  const [captureWarning, setCaptureWarning] = useState<string | null>(null);
  const latestSnapshot = useRef<BrowserDesignResult | null>(null);
  const latestPageUrl = useRef(pageUrl);
  useEffect(() => {
    latestPageUrl.current = pageUrl;
  }, [pageUrl]);
  const run = useCallback(
    async (operation: BrowserDesignInput["operation"]) => {
      if (!cwd) return false;
      const draft = useComposerDraftStore.getState().getComposerDraft(threadRef);
      if (
        operation !== "start" &&
        lastContextVersion.current &&
        !draft?.previewAnnotations.some((entry) => entry.id === annotationId)
      ) {
        const acknowledged = await execute({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            tabId,
            clientId,
            operation: "acknowledge",
            contextVersion: lastContextVersion.current,
          },
        });
        if (acknowledged._tag !== "Success") return false;
        lastContextVersion.current = null;
        lastChanges.current = null;
        sessionStorage.removeItem(contextKey);
      }
      const result = await execute({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          tabId,
          clientId,
          operation,
          ...(operation === "start" ? { mode: initialMode.current } : {}),
          contextVersion: latestSnapshot.current?.contextVersion,
        },
      });
      if (result._tag !== "Success") {
        if (mounted.current)
          setError("Designer disconnected. Turn Design off and on to reconnect this window.");
        return false;
      }
      const next = {
        ...result.value,
        notes: result.value.notes.map((note) => {
          const previous = latestSnapshot.current?.notes.find((entry) => entry.id === note.id);
          return !note.screenshot && previous?.screenshot
            ? { ...note, screenshot: previous.screenshot }
            : note;
        }),
      };
      latestSnapshot.current = next;
      const signature = JSON.stringify([next.changes, next.notes]);
      const store = useComposerDraftStore.getState();
      if (signature !== lastChanges.current) {
        lastChanges.current = signature;
        const imageIds = new Set(next.notes.map((note) => `design-note-${note.id}`));
        for (const image of store.getComposerDraft(threadRef)?.images ?? []) {
          if (image.id.startsWith("design-note-") && !imageIds.has(image.id))
            store.removeImage(threadRef, image.id);
        }
        for (const note of next.notes) {
          const imageId = `design-note-${note.id}`;
          if (!note.screenshot || seenNoteImages.current.has(imageId)) continue;
          seenNoteImages.current.add(imageId);
          if (store.getComposerDraft(threadRef)?.images.some((image) => image.id === imageId))
            continue;
          try {
            const file = dataUrlToFile(note.screenshot.dataUrl, `${imageId}.jpg`, "image/jpeg");
            const added = store.addImage(threadRef, {
              type: "image",
              id: imageId,
              name: file.name,
              mimeType: file.type,
              sizeBytes: file.size,
              previewUrl: note.screenshot.dataUrl,
              file,
            });
            if (!added)
              setCaptureWarning("Note saved. The composer could not accept its screenshot.");
          } catch {
            setCaptureWarning("Note saved, but its screenshot could not be attached.");
          }
        }
        if (next.changes.length > 0 || next.notes.length > 0) {
          store.addPreviewAnnotation(
            threadRef,
            designChangesAnnotation(annotationId, latestPageUrl.current, {
              ...next,
              notes: next.notes.map((note) => {
                if (
                  useComposerDraftStore
                    .getState()
                    .getComposerDraft(threadRef)
                    ?.images.some((image) => image.id === `design-note-${note.id}`)
                )
                  return note;
                const { screenshot: _screenshot, ...withoutImage } = note;
                return withoutImage;
              }),
            }),
            { insertAtCaret: false },
          );
          lastContextVersion.current = next.contextVersion;
          sessionStorage.setItem(contextKey, next.contextVersion);
        } else {
          lastContextVersion.current = null;
          sessionStorage.removeItem(contextKey);
          store.removePreviewAnnotation(threadRef, annotationId);
        }
      }
      if (mounted.current) {
        setSnapshot(next);
        setError(null);
      }
      return true;
    },
    [annotationId, clientId, cwd, execute, contextKey, tabId, threadRef],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    onActiveChange(active);
    return () => onActiveChange(false);
  }, [active, onActiveChange]);
  useEffect(() => {
    if (!active || !canWrite || !canPreview || disabled || !hasControl || !cwd) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const sync = async (operation: "start" | "sync") => {
      await run(operation);
      if (!cancelled) timer = setTimeout(() => void sync("sync"), 750);
    };
    void sync("start");
    return () => {
      cancelled = true;
      clearTimeout(timer);
      void run("stop");
    };
  }, [active, canPreview, canWrite, cwd, disabled, hasControl, run]);

  const toggle = () => {
    const next = !active;
    sessionStorage.setItem(key, next ? "active" : "browse");
    setActive(next);
  };
  const step = async (operation: "undo" | "redo") => {
    setPending(true);
    await run(operation);
    if (mounted.current) setPending(false);
  };
  return (
    <div className="shrink-0 border-b border-border/60 bg-background">
      <div className="flex min-h-9 flex-wrap items-center gap-2 px-3 py-1">
        <Button
          variant={active ? "secondary" : "ghost-muted"}
          size="xs"
          disabled={!active && (disabled || !hasControl || !canWrite || !canPreview || !cwd)}
          aria-pressed={active}
          onClick={() => {
            initialMode.current = "style";
            toggle();
          }}
        >
          <Palette /> Design
        </Button>
        <Button
          variant="ghost-muted"
          size="xs"
          disabled={disabled || !hasControl || !canWrite || !canPreview || !cwd}
          onClick={() => {
            initialMode.current = "annotate";
            if (active) void run("start");
            else {
              sessionStorage.setItem(key, "active");
              setActive(true);
            }
          }}
        >
          <MessageSquare /> Annotate
        </Button>
        {active ? (
          <>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Undo design edit"
              disabled={disabled || !hasControl || pending || !snapshot?.canUndo}
              onClick={() => void step("undo")}
            >
              <Undo2 />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Redo design edit"
              disabled={disabled || !hasControl || pending || !snapshot?.canRedo}
              onClick={() => void step("redo")}
            >
              <Redo2 />
            </Button>
            <span className="flex-1 text-xs text-muted-foreground" role="status">
              {!hasControl
                ? "Take browser control to edit or annotate"
                : disabled
                  ? "Open a page to use Designer"
                  : (error ??
                    captureWarning ??
                    (pending ? "Updating source…" : "Autosave on · Select an element to edit"))}
            </span>
            <Button
              variant="ghost-muted"
              size="xs"
              aria-expanded={showHistory}
              onClick={() => setShowHistory(!showHistory)}
            >
              {designChangesLabel(snapshot ?? { changes: [], notes: [] })}
            </Button>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">
            {hasControl
              ? "Select Design to edit source, or Annotate to attach a note"
              : "Take browser control to edit or annotate"}
          </span>
        )}
      </div>
      {active && showHistory ? (
        <ol
          aria-label="Design history"
          className="max-h-32 overflow-auto border-t border-border/60 px-4 py-2 text-xs"
        >
          <li className="py-1 font-medium">Saved to source</li>
          {snapshot?.changes.map((change) => (
            <li
              key={`${change.relativePath}:${change.selector}:${change.property}`}
              className="py-1"
            >
              {change.relativePath} · {change.property}: {change.previousValue} → {change.value}
            </li>
          ))}
          <li className="py-1 font-medium">Pending instructions</li>
          {snapshot?.notes.map((note) => (
            <li key={note.id} className="py-1">
              {note.comment}
            </li>
          ))}
          <li className="py-1 font-medium">Undo history</li>
          {snapshot?.history.length ? (
            snapshot.history.toReversed().map((entry) => (
              <li
                key={entry.id}
                className={entry.applied ? "py-1" : "py-1 text-muted-foreground line-through"}
              >
                {entry.label}
              </li>
            ))
          ) : (
            <li className="text-muted-foreground">Your saved edits will appear here.</li>
          )}
        </ol>
      ) : null}
    </div>
  );
}
