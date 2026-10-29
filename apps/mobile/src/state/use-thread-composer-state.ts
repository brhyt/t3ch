import * as Dialog from "../components/ui/Dialog";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { readEnvironmentScope } from "./session";
import type { ComposerTextPaste } from "../native/T3ComposerEditor.types";
import { useAtomValue } from "@effect/atom-react";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import { resolvePendingHandoff } from "@t3tools/client-runtime/handoff";
import {
  filterConversationTurnItems,
  sortThreadConversations,
} from "@t3tools/client-runtime/thread-conversations";
import {
  deriveProviderSubagentStatus,
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveThreadRuntime,
  threadRuntimeHasInterruptibleRun,
} from "@t3tools/client-runtime/state/thread-execution";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadConversationId,
  type ThreadConversationMutation,
  type ThreadConversationState,
  type ThreadId,
} from "@t3tools/contracts";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import { nextPastedTextFileName, pastedTextDisposition } from "@t3tools/client-runtime/text-paste";
import {
  parseCodexFeedbackCommand,
  submitCodexFeedback,
  type CodexFeedbackSubmission,
} from "@t3tools/client-runtime/state/threads";
import { resolveThreadWorkingStartedAt } from "@t3tools/client-runtime/state/models";
import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";
import {
  composerContextSendBlockReason,
  reidentifyComposerContext,
  uploadedComposerContext,
} from "../lib/composerContext";
import { uuidv4 } from "../lib/uuid";
import { mobileSupportsThreadConversations } from "../lib/threadConversations";

import { makeQueuedMessageMetadata } from "../lib/commandMetadata";
import {
  describeUnavailableModelSelection,
  isModelSelectionUnavailable,
} from "../lib/modelOptions";
import { resolveProviderInteractionMode } from "./legacy-plan-mode";
import {
  convertPastedImagesToAttachments,
  createPastedTextComposerAttachment,
  pasteComposerClipboard,
  pickComposerFiles,
  pickComposerMedia,
  removePersistedComposerAttachmentFile,
} from "../lib/composerImages";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { scopedThreadKey } from "../lib/scopedEntities";
import { buildThreadFeed } from "../lib/threadActivity";
import { acknowledgedThreadMessagesAtom } from "./acknowledged-thread-messages";
import { appendPendingThreadMessages } from "../features/threads/pending-thread-feed";
import { threadAllowsProviderSwitch } from "./thread-provider-switching";
import { appAtomRegistry } from "../state/atom-registry";
import { pendingThreadCreationMessage } from "./pending-thread-creation";
import {
  composerAttachmentUploadBlockReason,
  composerAttachmentUploadsAtom,
} from "../state/composer-attachment-uploads";
import {
  appendComposerDraftAttachments,
  captureComposerDraftInsertion,
  countComposerDraftAttachmentsAfterSelection,
  insertComposerDraftText,
  insertComposerDraftContext,
  clearComposerDraftContent,
  setComposerDraftAttachmentUpload,
  flushComposerDrafts,
  composerDraftsAtom,
  composerContextImportsAtom,
  ensureComposerDraftsLoaded,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  removeComposerDraftAttachment,
  scheduleUnusedComposerAttachmentCleanup,
  setComposerDraftText,
  updateComposerDraftSettings,
  useComposerDraft,
} from "./use-composer-drafts";
import {
  resolveComposerDispatchMode,
  type ActiveTurnComposerAction,
} from "@t3tools/client-runtime/state/composer-dispatch";
import { Atom } from "effect/reactivity";
import { AsyncResult } from "effect/reactivity";
import { prepareTurnAttachments, type PreparedTurnAttachments } from "../lib/attachmentUpload";
import { DEFAULT_FOLLOW_UP_BEHAVIOR } from "../lib/followUpBehavior";
import { mobilePreferencesAtom } from "./preferences";
import { environmentThreadDetails } from "./threads";
import {
  endQueuedRunEdit,
  getQueuedRunEdit,
  queuedEditDraftKey,
  removeQueuedRunEditAttachment,
  resolveQueuedEditPayload,
  useQueuedRunEdit,
} from "./queued-run-edit";
import { setPendingConnectionError } from "../state/use-remote-environment-registry";
import { clearThreadComposerError, setThreadComposerError } from "./thread-composer-error";
import {
  useSelectedThreadProjection,
  useSelectedThreadVisibleTurnItems,
} from "../state/use-thread-detail";
import { useThreadSelection } from "../state/use-thread-selection";
import { enqueueThreadOutboxMessage } from "./thread-outbox";
import { dispatchingQueuedMessageIdAtom, useThreadOutboxMessages } from "./use-thread-outbox";
import { threadEnvironment } from "./threads";
import { loadOrCreateMultitaskRetry, clearMultitaskRetry } from "./multitask-retry";
import { useAtomCommand } from "./use-atom-command";
import { orchestrationEnvironment } from "./orchestration";

const EMPTY_QUEUE_WORKFLOW_ATOM = Atom.make<null>(null).pipe(
  Atom.withLabel("mobile-thread-queue-workflow:empty"),
);

export function appendReviewCommentToDraft(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly attachments?: ReadonlyArray<DraftComposerImageAttachment>;
}): void {
  const threadKey = scopedThreadKey(input.environmentId, input.threadId);
  const upgraded = upgradeLegacyContextMessage(input.text);
  if (
    !insertComposerDraftContext(
      threadKey,
      reidentifyComposerContext(upgraded.text, upgraded.records, uuidv4),
    )
  ) {
    Dialog.alert("Too many context items", "Remove some context from the draft and try again.");
    return;
  }
  if (input.attachments && input.attachments.length > 0) {
    const rejectedCount = appendComposerDraftAttachments(threadKey, input.attachments, {
      appendReference: true,
    });
    if (rejectedCount > 0) {
      setPendingConnectionError(
        `${rejectedCount} comment attachment${rejectedCount === 1 ? " was" : "s were"} not added. Messages can contain at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
      );
    }
  }
}

/**
 * Resolved per call rather than captured, so a callback created before the
 * edit began still writes to the right place.
 */
function activeComposerDraftKey(thread: {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
}): string {
  const threadKey = scopedThreadKey(thread.environmentId, thread.id);
  const edit = getQueuedRunEdit(threadKey);
  return edit === null ? threadKey : queuedEditDraftKey(threadKey, edit.runId);
}

export function useThreadDraftForThread(input: {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
}) {
  const threadKey =
    input.environmentId && input.threadId
      ? scopedThreadKey(input.environmentId, input.threadId)
      : null;
  const draft = useComposerDraft(threadKey);

  return {
    draftMessage: draft.text,
    draftAttachments: draft.attachments,
  };
}

export function useThreadComposerState() {
  const {
    selectedThread: selectedThreadShell,
    selectedThreadCreation,
    selectedThreadDetailRef,
    selectedEnvironmentRuntime,
  } = useThreadSelection();
  const selectedThreadProjection = useSelectedThreadProjection();
  const selectedThreadVisibleTurnItems = useSelectedThreadVisibleTurnItems();
  const [selectedConversationIds, setSelectedConversationIds] = useState<
    Record<string, ThreadConversationId | null>
  >({});
  const composerDrafts = useAtomValue(composerDraftsAtom);
  const acknowledgedMessages = useAtomValue(acknowledgedThreadMessagesAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const dispatchingQueuedMessageId = useAtomValue(dispatchingQueuedMessageIdAtom);
  const [feedbackSubmissionsByThreadKey, setFeedbackSubmissionsByThreadKey] = useState<
    Record<string, ReadonlyArray<CodexFeedbackSubmission>>
  >({});
  const uploadThreadFeedback = useAtomCommand(threadEnvironment.uploadFeedback, {
    reportFailure: false,
  });
  const editQueuedRun = useAtomCommand(threadEnvironment.editQueuedRun, {
    label: "edit queued message",
    reportFailure: false,
  });
  const dispatchOrchestrationCommand = useAtomCommand(
    orchestrationEnvironment.v2.dispatchCommand,
    "update conversation",
  );

  const startMultitask = useAtomCommand(threadEnvironment.startMultitask, { reportFailure: false });
  const multitaskRetryRef = useRef<{
    key: string;
    commandId: CommandId;
    messageId: MessageId;
  } | null>(null);
  const multitaskBusyRef = useRef(false);
  const multitaskAttachmentsRef = useRef<{ key: string; prepared: PreparedTurnAttachments } | null>(
    null,
  );
  const [isSavingQueuedEdit, setIsSavingQueuedEdit] = useState(false);
  const savingQueuedEditRef = useRef(false);
  const pastedTextFileNamesRef = useRef<{ threadKey: string | null; names: Set<string> }>({
    threadKey: null,
    names: new Set(),
  });
  const reservePastedTextFileName = useCallback(
    (threadKey: string, existingNames: ReadonlyArray<string>) => {
      if (pastedTextFileNamesRef.current.threadKey !== threadKey) {
        pastedTextFileNamesRef.current = { threadKey, names: new Set() };
      }
      const names = pastedTextFileNamesRef.current.names;
      for (const name of existingNames) names.add(name);
      const nextName = nextPastedTextFileName([...names]);
      names.add(nextName);
      return nextName;
    },
    [],
  );

  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);

  const selectedThreadKey = selectedThreadShell
    ? scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
    : null;
  const selectedConversationId =
    selectedThreadKey === null ? null : (selectedConversationIds[selectedThreadKey] ?? null);
  const setSelectedConversationId = useCallback(
    (id: ThreadConversationId | null) => {
      if (selectedThreadKey === null) return;
      setSelectedConversationIds((current) => ({ ...current, [selectedThreadKey]: id }));
    },
    [selectedThreadKey],
  );
  const supportsThreadConversations = mobileSupportsThreadConversations(
    selectedEnvironmentRuntime?.serverConfig?.environment.capabilities,
  );
  const activeConversationId = supportsThreadConversations ? selectedConversationId : null;
  const projectedConversations = selectedThreadProjection?.projection.thread.conversations;
  const conversations = useMemo(
    () =>
      supportsThreadConversations ? sortThreadConversations(projectedConversations ?? []) : [],
    [projectedConversations, supportsThreadConversations],
  );
  const conversationTurnItems = useMemo(
    () =>
      filterConversationTurnItems(
        selectedThreadVisibleTurnItems,
        activeConversationId,
        selectedThreadProjection?.projection.turnItems,
      ),
    [
      activeConversationId,
      selectedThreadProjection?.projection.turnItems,
      selectedThreadVisibleTurnItems,
    ],
  );
  const selectedThreadQueuedMessages = useMemo(
    () =>
      selectedThreadKey
        ? (queuedMessagesByThreadKey[selectedThreadKey] ?? []).filter(
            (message) => message.creation === undefined,
          )
        : [],
    [queuedMessagesByThreadKey, selectedThreadKey],
  );
  const visibleQueuedMessages = useMemo(
    () =>
      activeConversationId === null
        ? selectedThreadQueuedMessages
        : selectedThreadQueuedMessages.filter(
            (message) => message.conversationId === activeConversationId,
          ),
    [activeConversationId, selectedThreadQueuedMessages],
  );
  const feedbackSubmissions = useMemo(
    () => (selectedThreadKey ? (feedbackSubmissionsByThreadKey[selectedThreadKey] ?? []) : []),
    [feedbackSubmissionsByThreadKey, selectedThreadKey],
  );
  const dismissFeedback = useCallback(
    (id: MessageId) => {
      if (!selectedThreadKey) return;
      setFeedbackSubmissionsByThreadKey((current) => ({
        ...current,
        [selectedThreadKey]: (current[selectedThreadKey] ?? []).filter((entry) => entry.id !== id),
      }));
    },
    [selectedThreadKey],
  );
  const selectedThreadMessages = selectedThreadProjection?.projection.messages;
  const selectedThreadAttempts = selectedThreadProjection?.projection.attempts;
  const selectedThreadNodes = selectedThreadProjection?.projection.nodes;
  // A thread whose creation has not delivered its turn yet: the prompt only
  // exists in the outbox, so it is appended to whatever the server has. The
  // detail is usually present but empty during a worktree checkout, so this
  // cannot be an either/or with the loaded messages.
  const pendingCreationMessage = selectedThreadCreation?.message ?? null;
  const selectedThreadFeed = useMemo(() => {
    const pendingCreation =
      pendingCreationMessage !== null &&
      !selectedThreadMessages?.some((message) => message.id === pendingCreationMessage.messageId)
        ? [pendingThreadCreationMessage(pendingCreationMessage)]
        : [];
    const feed = buildThreadFeed(conversationTurnItems, {
      anchoredMessages: pendingCreation,
      attempts: selectedThreadAttempts,
      nodes: selectedThreadNodes,
    });
    const pendingAcknowledgments = acknowledgedMessages.filter(
      (message) =>
        scopedThreadKey(message.environmentId, message.threadId) === selectedThreadKey &&
        (activeConversationId === null || message.conversationId === activeConversationId) &&
        !selectedThreadQueuedMessages.some((queued) => queued.messageId === message.messageId),
    );
    if (pendingAcknowledgments.length === 0) return feed;
    return appendPendingThreadMessages(feed, feed, pendingAcknowledgments).map((entry) =>
      entry.pendingMessage ? { ...entry, acknowledged: true } : entry,
    );
  }, [
    selectedThreadMessages,
    selectedThreadAttempts,
    selectedThreadNodes,
    conversationTurnItems,
    pendingCreationMessage,
    selectedThreadKey,
    selectedThreadQueuedMessages,
    activeConversationId,
    acknowledgedMessages,
  ]);
  useEffect(() => {
    const echoedIds = new Set(selectedThreadMessages?.map((message) => message.id));
    if (acknowledgedMessages.some((message) => echoedIds.has(message.messageId))) {
      appAtomRegistry.set(
        acknowledgedThreadMessagesAtom,
        appAtomRegistry
          .get(acknowledgedThreadMessagesAtom)
          .filter((message) => !echoedIds.has(message.messageId)),
      );
    }
  }, [acknowledgedMessages, selectedThreadMessages]);

  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const followUpBehavior = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.followUpBehavior ?? DEFAULT_FOLLOW_UP_BEHAVIOR)
    : DEFAULT_FOLLOW_UP_BEHAVIOR;
  const queueWorkflow = useAtomValue(
    selectedThreadDetailRef === null
      ? EMPTY_QUEUE_WORKFLOW_ATOM
      : environmentThreadDetails.queueWorkflowAtom(selectedThreadDetailRef),
  );
  const queuedRunEdit = useQueuedRunEdit(selectedThreadKey);
  const composerDraftKey =
    selectedThreadKey === null
      ? null
      : queuedRunEdit === null
        ? selectedThreadKey
        : queuedEditDraftKey(selectedThreadKey, queuedRunEdit.runId);
  const editedDraft = composerDraftKey ? composerDrafts[composerDraftKey] : null;
  const selectedDraft = selectedThreadKey ? composerDrafts[selectedThreadKey] : null;
  const draftMessage = editedDraft?.text ?? "";
  const draftAttachments = editedDraft?.attachments ?? [];
  const selectedThreadQueueCount = selectedThreadQueuedMessages.length;
  const selectedThread = selectedThreadShell;
  const modelSelection = selectedDraft?.modelSelection ?? selectedThread?.modelSelection ?? null;
  const pendingHandoff = useMemo(
    () =>
      resolvePendingHandoff(
        selectedThreadProjection?.projection,
        modelSelection,
        selectedEnvironmentRuntime?.serverConfig?.providers ?? [],
      ),
    [modelSelection, selectedThreadProjection, selectedEnvironmentRuntime?.serverConfig?.providers],
  );
  const runtimeMode = selectedDraft?.runtimeMode ?? selectedThread?.runtimeMode ?? null;
  const selectedProvider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
    (provider) => provider.instanceId === modelSelection?.instanceId,
  );
  const interactionMode = selectedThread
    ? resolveProviderInteractionMode(
        selectedProvider,
        selectedDraft?.interactionMode ?? selectedThread.interactionMode,
      )
    : null;
  const canSwitchThreadProvider = useMemo(
    () =>
      threadAllowsProviderSwitch({
        thread: selectedThreadShell,
        projection: selectedThreadProjection?.projection,
      }),
    [selectedThreadProjection, selectedThreadShell],
  );
  const selectedThreadRuntime = useMemo(
    () =>
      selectedThreadProjection
        ? deriveThreadRuntime(selectedThreadProjection.projection)
        : (selectedThreadShell?.runtime ?? null),
    [selectedThreadProjection, selectedThreadShell?.runtime],
  );
  const selectedThreadActivityRun = useMemo(
    () =>
      selectedThreadProjection
        ? deriveThreadActivityRun(selectedThreadProjection.projection)
        : (selectedThreadShell?.latestRun ?? null),
    [selectedThreadProjection, selectedThreadShell?.latestRun],
  );

  const isCompacting = useMemo(() => {
    const queuedCompact = selectedThreadQueuedMessages.some(
      (message) =>
        message.messageId === dispatchingQueuedMessageId &&
        message.text.trim().toLowerCase() === "/compact" &&
        message.attachments.length === 0,
    );
    if (queuedCompact) return true;
    const activeRunId = selectedThreadRuntime?.activeRunId;
    if (!activeRunId || !threadRuntimeIsActive(selectedThreadRuntime)) return false;
    const compactMessage = selectedThreadVisibleTurnItems.findLast(
      ({ item }) =>
        item.runId === activeRunId &&
        item.type === "user_message" &&
        item.text.trim().toLowerCase() === "/compact" &&
        item.attachments.length === 0,
    );
    if (!compactMessage) return false;
    return !selectedThreadVisibleTurnItems.some(
      ({ item }) =>
        item.runId === activeRunId &&
        item.type === "compaction" &&
        (item.status === "completed" || item.status === "failed"),
    );
  }, [
    dispatchingQueuedMessageId,
    selectedThreadQueuedMessages,
    selectedThreadRuntime,
    selectedThreadVisibleTurnItems,
  ]);
  // A compacting turn cannot take steering input, so follow-ups queue meanwhile.
  const canSteerActiveTurn = queueWorkflow?.canPromoteToSteer === true && !isCompacting;

  const runlessWorkStartedAt = useMemo(
    () =>
      selectedThreadProjection
        ? deriveRunlessWorkStartedAt(selectedThreadProjection.projection)
        : null,
    [selectedThreadProjection],
  );
  const activeWorkStartedAt = useMemo(() => {
    if (!selectedThreadShell) {
      return null;
    }
    return (
      resolveThreadWorkingStartedAt({
        latestRun: selectedThreadActivityRun,
        runtime: selectedThreadRuntime,
      }) ?? runlessWorkStartedAt
    );
  }, [selectedThreadActivityRun, runlessWorkStartedAt, selectedThreadRuntime, selectedThreadShell]);
  const runlessWorkActive = runlessWorkStartedAt !== null;

  const providerSubagentStatus = useMemo(
    () =>
      selectedThreadProjection
        ? deriveProviderSubagentStatus(selectedThreadProjection.projection)
        : null,
    [selectedThreadProjection],
  );

  const selectedThreadRuns = selectedThreadProjection?.projection.runs;
  const editedRunId = queuedRunEdit?.runId ?? null;
  useEffect(() => {
    if (selectedThreadKey === null || editedRunId === null || selectedThreadRuns === undefined) {
      return;
    }
    if (savingQueuedEditRef.current) return;
    const stillQueued = selectedThreadRuns.some(
      (run) => run.id === editedRunId && run.status === "queued",
    );
    if (stillQueued) return;
    const editDraftKey = queuedEditDraftKey(selectedThreadKey, editedRunId);
    const editDraft = getComposerDraftSnapshot(editDraftKey);
    const threadDraft = getComposerDraftSnapshot(selectedThreadKey);
    const keepable =
      editDraft.text.trim().length > 0 &&
      threadDraft.text.trim().length === 0 &&
      threadDraft.attachments.length === 0;
    if (keepable) {
      void mergeComposerDraftContent(selectedThreadKey, {
        text: editDraft.text,
        attachments: editDraft.attachments,
        ...(editDraft.context ? { context: editDraft.context } : {}),
      });
    }
    endQueuedRunEdit(selectedThreadKey, { deferAttachmentCleanup: keepable });
    setThreadComposerError(
      selectedThreadKey,
      keepable
        ? "That message already started. Your edit is back in the composer."
        : "That message already started, so the edit was discarded.",
    );
  }, [editedRunId, selectedThreadKey, selectedThreadRuns]);

  const activeThreadBusy = threadRuntimeIsActive(selectedThreadRuntime);
  const interruptibleRunId = threadRuntimeHasInterruptibleRun(selectedThreadRuntime)
    ? (selectedThreadRuntime?.activeRunId ?? null)
    : null;

  const cancelQueuedRunEdit = useCallback(() => {
    if (selectedThreadKey === null || savingQueuedEditRef.current) return;
    endQueuedRunEdit(selectedThreadKey);
  }, [selectedThreadKey]);

  const onRemoveQueuedEditAttachment = useCallback(
    (attachmentId: string) => {
      if (selectedThreadKey === null) return;
      removeQueuedRunEditAttachment(selectedThreadKey, attachmentId);
    },
    [selectedThreadKey],
  );

  const saveQueuedRunEdit = useCallback(async () => {
    const thread = selectedThreadShell;
    if (!thread || savingQueuedEditRef.current) return;
    const threadKey = scopedThreadKey(thread.environmentId, thread.id);
    const edit = getQueuedRunEdit(threadKey);
    if (edit === null) return;
    const draft = getComposerDraftSnapshot(queuedEditDraftKey(threadKey, edit.runId));
    const text = draft.text.trim();
    if (text.length === 0) {
      // The server rejects an empty queued message, attachments or not.
      Dialog.alert("Add a message", "A queued message cannot be left empty.");
      return;
    }
    if (
      edit.existingAttachments.length + draft.attachments.length >
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    ) {
      Dialog.alert(
        "Too many attachments",
        `Remove attachments until there are at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}.`,
      );
      return;
    }
    savingQueuedEditRef.current = true;
    setIsSavingQueuedEdit(true);
    try {
      const capabilities = selectedEnvironmentRuntime?.serverConfig?.environment.capabilities;
      const prepared = await prepareTurnAttachments({
        environmentId: thread.environmentId,
        attachments: draft.attachments,
        supportsImageUploads: capabilities?.attachmentUploads === true,
      });
      if (prepared.status !== "ready") return;
      const payload = resolveQueuedEditPayload({
        edit,
        draftContext: draft.context,
        draftAttachments: draft.attachments,
        uploaded: prepared.attachments,
      });
      const result = await editQueuedRun({
        environmentId: thread.environmentId,
        input: {
          threadId: thread.id,
          runId: edit.runId,
          text,
          edit: {
            messageId: edit.messageId,
            attachments: payload.attachments,
            ...(payload.context ? { context: payload.context } : {}),
          },
        },
      });
      if (result._tag !== "Success") {
        Dialog.alert(
          "Could not save the queued message",
          "It may have already started. Your edit is still in the composer.",
        );
        return;
      }
      endQueuedRunEdit(threadKey, { deferAttachmentCleanup: true });
      scheduleUnusedComposerAttachmentCleanup(draft.attachments);
    } finally {
      savingQueuedEditRef.current = false;
      setIsSavingQueuedEdit(false);
    }
  }, [editQueuedRun, selectedEnvironmentRuntime?.serverConfig, selectedThreadShell]);

  const onStartMultitask = useCallback(async () => {
    const thread = selectedThreadShell;
    if (
      !thread ||
      selectedThreadCreation !== null ||
      multitaskBusyRef.current ||
      selectedEnvironmentRuntime?.connectionState !== "connected" ||
      !appAtomRegistry.get(threadEnvironment.startMultitask.permissionAtom(thread.environmentId))
    )
      return;
    const threadKey = scopedThreadKey(thread.environmentId, thread.id);
    if (getQueuedRunEdit(threadKey) || appAtomRegistry.get(composerContextImportsAtom)[threadKey])
      return;
    const draft = getComposerDraftSnapshot(threadKey);
    const text = draft.text.trim();
    if (
      !text ||
      composerContextSendBlockReason(draft.context) ||
      draft.attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    )
      return;
    if (
      composerAttachmentUploadBlockReason({
        environmentId: thread.environmentId,
        attachments: draft.attachments,
        connected: true,
        serverConfig: selectedEnvironmentRuntime.serverConfig,
        states: appAtomRegistry.get(composerAttachmentUploadsAtom),
      })
    )
      return;
    const modelSelection = draft.modelSelection ?? thread.modelSelection;
    if (
      isModelSelectionUnavailable(
        selectedEnvironmentRuntime.serverConfig,
        modelSelection,
        thread.projectId,
      )
    )
      return;
    const key = JSON.stringify([
      threadKey,
      text,
      draft.attachments.map((attachment) => attachment.id),
      draft.context,
      modelSelection,
      draft.runtimeMode ?? thread.runtimeMode,
      draft.interactionMode ?? thread.interactionMode,
    ]);
    multitaskBusyRef.current = true;
    try {
      const retry =
        multitaskRetryRef.current?.key === key
          ? multitaskRetryRef.current
          : await loadOrCreateMultitaskRetry(threadKey, key);
      multitaskRetryRef.current = retry;
      const prepared =
        multitaskAttachmentsRef.current?.key === key
          ? multitaskAttachmentsRef.current.prepared
          : await prepareTurnAttachments({
              environmentId: thread.environmentId,
              attachments: draft.attachments,
              persistUploadedReferences: async (attachments) => {
                for (const attachment of attachments)
                  setComposerDraftAttachmentUpload(threadKey, attachment);
                await flushComposerDrafts();
                return "persisted";
              },
              supportsImageUploads:
                selectedEnvironmentRuntime.serverConfig?.environment.capabilities
                  .attachmentUploads === true,
            });
      if (prepared.status !== "ready") return;
      multitaskAttachmentsRef.current = { key, prepared };
      const attachments = prepared.attachments.map((attachment, index) => ({
        ...attachment,
        id:
          "id" in attachment && typeof attachment.id === "string"
            ? attachment.id
            : (draft.attachments[index]?.id ?? `${retry.messageId}:${index}`),
      }));
      const context = uploadedComposerContext(draft.context, draft.attachments, attachments);
      const result = await startMultitask({
        environmentId: thread.environmentId,
        input: {
          commandId: retry.commandId,
          messageId: retry.messageId,
          parentThreadId: thread.id,
          text,
          attachments,
          ...(context ? { context } : {}),
          modelSelection,
          runtimeMode: draft.runtimeMode ?? thread.runtimeMode,
          interactionMode: draft.interactionMode ?? thread.interactionMode,
          creationSource: "mobile",
          isolation: "worktree",
        },
      });
      if (result._tag !== "Success") {
        setThreadComposerError(
          threadKey,
          "Could not start the parallel task. Your draft is preserved; retry to resume it.",
        );
        return;
      }
      const current = getComposerDraftSnapshot(threadKey);
      if (
        current.text === draft.text &&
        JSON.stringify(current.attachments.map((attachment) => attachment.id)) ===
          JSON.stringify(draft.attachments.map((attachment) => attachment.id)) &&
        current.context === draft.context
      ) {
        clearComposerDraftContent(threadKey, { deferAttachmentCleanup: true });
        scheduleUnusedComposerAttachmentCleanup(draft.attachments);
      }
      clearThreadComposerError(threadKey);
      await clearMultitaskRetry(threadKey);
      multitaskRetryRef.current = null;
      multitaskAttachmentsRef.current = null;
    } catch (error) {
      setThreadComposerError(
        threadKey,
        error instanceof Error ? error.message : "Could not start the parallel task.",
      );
    } finally {
      multitaskBusyRef.current = false;
    }
  }, [
    selectedThreadShell,
    selectedThreadCreation,
    selectedEnvironmentRuntime?.connectionState,
    selectedEnvironmentRuntime?.serverConfig,
    startMultitask,
  ]);

  const onSendMessage = useCallback(
    async (followUpOverride?: ActiveTurnComposerAction) => {
      if (
        selectedThreadShell &&
        selectedEnvironmentRuntime?.connectionState === "connected" &&
        !readEnvironmentScope(selectedThreadShell.environmentId, AuthOrchestrationOperateScope)
      )
        return null;
      if (!selectedThreadShell) {
        return null;
      }
      // The server has not created this thread yet. Queuing a follow-up against
      // its id would strand the message: if the creation is rejected the thread
      // never appears and the drain drops the orphan. The composer disables its
      if (selectedThreadCreation !== null) {
        return null;
      }

      const editKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      if (getQueuedRunEdit(editKey) !== null) {
        await saveQueuedRunEdit();
        return null;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      const draft = getComposerDraftSnapshot(threadKey);
      if (appAtomRegistry.get(composerContextImportsAtom)[threadKey]) return null;
      const thread = selectedThreadShell;
      const text = draft.text.trim();
      const attachments = draft.attachments;
      if (
        composerAttachmentUploadBlockReason({
          environmentId: selectedThreadShell.environmentId,
          attachments,
          connected: selectedEnvironmentRuntime?.connectionState === "connected",
          serverConfig: selectedEnvironmentRuntime?.serverConfig ?? null,
          states: appAtomRegistry.get(composerAttachmentUploadsAtom),
        }) !== null
      )
        return null;
      if (text.length === 0 && attachments.length === 0) {
        return null;
      }
      // A send-failure restore appends with allowOverflow so it never drops the
      // user's files, which can leave the draft over the cap. Sending it anyway
      // would enqueue a message that outbox recovery rejects forever, so block
      // here until the user removes attachments.
      if (attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        Dialog.alert(
          "Too many attachments",
          `Remove attachments until there are at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}.`,
        );
        return null;
      }

      const contextBlockReason = composerContextSendBlockReason(draft.context);
      if (contextBlockReason) {
        Dialog.alert("Too much context", contextBlockReason);
        return null;
      }

      const modelSelection = draft.modelSelection ?? thread.modelSelection;
      const serverConfig = selectedEnvironmentRuntime?.serverConfig;
      if (
        selectedEnvironmentRuntime?.connectionState === "connected" &&
        isModelSelectionUnavailable(serverConfig, modelSelection, thread.projectId)
      ) {
        const { title, detail } = describeUnavailableModelSelection(
          serverConfig,
          modelSelection,
          thread.projectId,
        );
        Dialog.alert(title, detail);
        return null;
      }
      const provider = serverConfig?.providers.find(
        (entry) => entry.instanceId === modelSelection.instanceId,
      );
      const feedbackCommand =
        attachments.length === 0 && provider?.driver === "codex"
          ? parseCodexFeedbackCommand(text)
          : null;
      if (feedbackCommand) {
        if (!readEnvironmentScope(selectedThreadShell.environmentId, AuthOrchestrationOperateScope))
          return null;
        if (thread.activeProviderThreadId === null) {
          Dialog.alert("Start a Codex thread first", "Send a message before you submit feedback.");
          return null;
        }
        const metadata = makeQueuedMessageMetadata();
        await submitCodexFeedback({
          submission: {
            id: MessageId.make(metadata.messageId),
            command: text,
            createdAt: metadata.createdAt,
          },
          clearDraft: () => clearComposerDraftContent(threadKey),
          onUpdate: (submission) => {
            setFeedbackSubmissionsByThreadKey((current) => {
              const existing = current[threadKey] ?? [];
              const found = existing.some((entry) => entry.id === submission.id);
              return {
                ...current,
                [threadKey]: found
                  ? existing.map((entry) => (entry.id === submission.id ? submission : entry))
                  : [...existing, submission],
              };
            });
          },
          upload: () =>
            uploadThreadFeedback({
              environmentId: thread.environmentId,
              input: { threadId: thread.id, ...feedbackCommand },
            }),
        });
        return null;
      }

      // Resolved here rather than at drain time: the outbox can deliver minutes
      // later, and the choice belongs to the moment the user pressed send.
      // Steering travels as "auto" so a turn that ends in the meantime degrades
      // to a queued run on the server instead of failing the delivery and
      // bouncing the message back into the draft.
      const followUpAction = resolveComposerDispatchMode({
        running: activeThreadBusy && canSteerActiveTurn,
        alternateModifier: followUpOverride !== undefined && followUpOverride !== followUpBehavior,
        activeTurnDefault: followUpBehavior,
      });
      const setupRunning = [selectedThreadActivityRun?.status, selectedThreadRuntime?.status].some(
        (status) => status === "preparing" || status === "starting",
      );
      const followUpDispatchMode = setupRunning
        ? "queue"
        : followUpAction === "auto"
          ? null
          : followUpAction === "queue"
            ? "queue"
            : "auto";

      const metadata = makeQueuedMessageMetadata();
      const messageId = MessageId.make(metadata.messageId);
      const conversationId = activeConversationId;
      clearThreadComposerError(threadKey);
      const enqueuePromise = enqueueThreadOutboxMessage({
        environmentId: selectedThreadShell.environmentId,
        threadId: selectedThreadShell.id,
        messageId,
        commandId: CommandId.make(metadata.commandId),
        text,
        attachments,
        context: draft.context,
        modelSelection,
        runtimeMode: draft.runtimeMode ?? thread.runtimeMode,
        interactionMode: resolveProviderInteractionMode(
          provider,
          draft.interactionMode ?? thread.interactionMode,
        ),
        ...(conversationId === null ? {} : { conversationId }),
        ...(followUpDispatchMode === null ? {} : { dispatchMode: followUpDispatchMode }),
        createdAt: metadata.createdAt,
      });
      clearComposerDraftContent(threadKey, { deferAttachmentCleanup: true });
      enqueuePromise.then(
        () => scheduleUnusedComposerAttachmentCleanup(attachments),
        (error: unknown) => {
          // Restore text via merge (idempotent) but attachments via the uncapped
          // append: the merge path slots existing attachments first and truncates
          // at the send limit, which would silently drop this message's images if
          // the user attached new ones while the write was in flight.
          void mergeComposerDraftContent(threadKey, {
            text,
            context: draft.context,
            attachments: [],
          });
          appendComposerDraftAttachments(threadKey, attachments, { allowOverflow: true });
          setThreadComposerError(
            threadKey,
            error instanceof Error ? error.message : "Failed to save the queued message.",
          );
        },
      );
      return messageId;
    },
    [
      activeThreadBusy,
      canSteerActiveTurn,
      followUpBehavior,
      saveQueuedRunEdit,
      selectedEnvironmentRuntime?.connectionState,
      selectedEnvironmentRuntime?.serverConfig,
      selectedThreadActivityRun?.status,
      selectedThreadCreation,
      selectedThreadRuntime?.status,
      selectedThreadShell,
      activeConversationId,
      uploadThreadFeedback,
    ],
  );

  const mutateConversation = useCallback(
    async (conversationMutation: ThreadConversationMutation) => {
      if (!selectedThreadShell || !supportsThreadConversations) return false;
      const result = await dispatchOrchestrationCommand({
        environmentId: selectedThreadShell.environmentId,
        input: {
          type: "thread.metadata.update",
          commandId: CommandId.make(uuidv4()),
          threadId: selectedThreadShell.id,
          conversationMutation,
        },
      });
      return result._tag === "Success";
    },
    [dispatchOrchestrationCommand, selectedThreadShell, supportsThreadConversations],
  );

  const onCreateConversation = useCallback(
    async (title: string) => {
      const trimmed = title.trim();
      if (trimmed.length === 0) return;
      const id = ThreadConversationId.make(uuidv4());
      if (await mutateConversation({ type: "create", id, title: trimmed })) {
        setSelectedConversationId(id);
      }
    },
    [mutateConversation, setSelectedConversationId],
  );

  const onRenameConversation = useCallback(
    async (id: ThreadConversationId, title: string) => {
      const trimmed = title.trim();
      if (trimmed.length === 0) return;
      await mutateConversation({ type: "update", id, title: trimmed });
    },
    [mutateConversation],
  );

  const onUpdateConversationState = useCallback(
    async (id: ThreadConversationId, state: ThreadConversationState) => {
      await mutateConversation({ type: "update", id, state });
    },
    [mutateConversation],
  );

  const onAssignLatestExchange = useCallback(
    async (id: ThreadConversationId) => {
      if (!selectedThreadShell) return;
      const latestUserMessage = selectedThreadVisibleTurnItems.findLast(
        ({ item }) => item.type === "user_message" && item.threadId === selectedThreadShell.id,
      )?.item;
      if (!latestUserMessage || latestUserMessage.type !== "user_message") {
        Dialog.alert("No exchange to assign", "Send a message before assigning an exchange.");
        return;
      }
      const conversationIds = latestUserMessage.conversationIds ?? [];
      if (conversationIds.includes(id)) return;
      if (conversationIds.length >= 20) {
        Dialog.alert(
          "Too many conversations",
          "This exchange already belongs to 20 conversations.",
        );
        return;
      }
      await mutateConversation({
        type: "assign",
        messageIds: [latestUserMessage.messageId],
        conversationIds: [...conversationIds, id],
      });
    },
    [mutateConversation, selectedThreadShell, selectedThreadVisibleTurnItems],
  );

  const onChangeDraftMessage = useCallback(
    (value: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = activeComposerDraftKey(selectedThreadShell);
      setComposerDraftText(threadKey, value);
    },
    [selectedThreadShell],
  );

  const onPickDraftMedia = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = activeComposerDraftKey(selectedThreadShell);
    const insertion = captureComposerDraftInsertion(threadKey);
    const capabilities = selectedEnvironmentRuntime?.serverConfig?.environment.capabilities;
    const result = await pickComposerMedia({
      existingCount: countComposerDraftAttachmentsAfterSelection(threadKey, insertion),
      maxVideoBytes:
        capabilities?.attachmentUploads === true
          ? capabilities.fileAttachments?.maxUploadBytes
          : undefined,
    });
    const rejectedCount = appendComposerDraftAttachments(threadKey, result.attachments, {
      appendReference: true,
      insertion,
    });
    const problems = [
      ...(result.error ? [result.error] : []),
      ...(rejectedCount > 0
        ? [`You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments per message.`]
        : []),
    ];
    if (problems.length > 0) {
      Dialog.alert("Could not attach photo or video", problems.join("\n\n"));
    }
  }, [composerDrafts, selectedEnvironmentRuntime?.serverConfig, selectedThreadShell]);

  const onPickDraftFiles = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }
    const maxBytes =
      selectedEnvironmentRuntime?.serverConfig?.environment.capabilities.fileAttachments
        ?.maxUploadBytes;
    if (maxBytes === undefined) {
      Dialog.alert("Could not attach file", "This server does not support file attachments.");
      return;
    }

    const threadKey = activeComposerDraftKey(selectedThreadShell);
    const insertion = captureComposerDraftInsertion(threadKey);
    const result = await pickComposerFiles({
      existingCount: countComposerDraftAttachmentsAfterSelection(threadKey, insertion),
      maxBytes,
    });
    const rejectedCount = appendComposerDraftAttachments(threadKey, result.files, {
      appendReference: true,
      insertion,
    });
    const problems = [
      ...(result.error ? [result.error] : []),
      ...(rejectedCount > 0
        ? [`You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`]
        : []),
    ];
    if (problems.length > 0) {
      Dialog.alert("Could not attach file", problems.join("\n\n"));
    }
  }, [composerDrafts, selectedEnvironmentRuntime?.serverConfig, selectedThreadShell]);

  const onPasteIntoDraft = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = activeComposerDraftKey(selectedThreadShell);
    const insertion = captureComposerDraftInsertion(threadKey);
    const result = await pasteComposerClipboard({
      existingCount: countComposerDraftAttachmentsAfterSelection(threadKey, insertion),
    });
    const rejectedPasteCount = appendComposerDraftAttachments(threadKey, result.images, {
      appendReference: true,
      insertion,
    });
    if (result.text) {
      const currentDraft = getComposerDraftSnapshot(threadKey);
      const currentAttachments = currentDraft.attachments;
      const capabilities = selectedEnvironmentRuntime?.serverConfig?.environment.capabilities;
      const advertisedMax =
        capabilities?.attachmentUploads === true
          ? capabilities.fileAttachments?.maxUploadBytes
          : undefined;
      const maxBytes =
        advertisedMax === undefined ? null : clampFileAttachmentUploadBytes(advertisedMax);
      const wouldExceedInputLimit =
        currentDraft.text.length -
          (currentDraft.text === insertion.text
            ? Math.max(0, insertion.end - insertion.start)
            : 0) +
          result.text.length >
        PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
      const shouldFold =
        pastedTextDisposition({
          text: result.text,
          wouldExceedInputLimit,
          canAttach: true,
        }) === "attachment";
      const canAttach =
        maxBytes !== null &&
        countComposerDraftAttachmentsAfterSelection(threadKey, insertion) <
          PROVIDER_SEND_TURN_MAX_ATTACHMENTS &&
        new TextEncoder().encode(result.text).byteLength <= maxBytes;
      if (shouldFold && canAttach && maxBytes !== null) {
        try {
          const attachment = await createPastedTextComposerAttachment({
            text: result.text,
            name: reservePastedTextFileName(
              threadKey,
              currentAttachments.map((item) => item.name),
            ),
            maxBytes,
          });
          if (
            appendComposerDraftAttachments(threadKey, [attachment], {
              appendReference: true,
              insertion,
            }) > 0
          ) {
            await removePersistedComposerAttachmentFile(attachment.fileUri);
            setPendingConnectionError(
              `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
            );
          }
        } catch (error) {
          setPendingConnectionError(
            error instanceof Error ? error.message : "Could not attach pasted text.",
          );
        }
      } else if (shouldFold && !wouldExceedInputLimit) {
        insertComposerDraftText(threadKey, result.text, insertion);
      } else if (shouldFold) {
        setPendingConnectionError(
          wouldExceedInputLimit
            ? "Pasted text is too large for this message. Remove some text or an attachment, then paste again."
            : "Could not attach pasted text. Remove an attachment or use a smaller paste, then try again.",
        );
      } else {
        insertComposerDraftText(threadKey, result.text, insertion);
      }
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    } else if (rejectedPasteCount > 0) {
      setPendingConnectionError(
        `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
      );
    }
  }, [
    composerDrafts,
    reservePastedTextFileName,
    selectedEnvironmentRuntime?.serverConfig,
    selectedThreadShell,
  ]);

  const onNativePasteImages = useCallback(
    async (uris: ReadonlyArray<string>) => {
      if (!selectedThreadShell || uris.length === 0) {
        return;
      }

      const threadKey = activeComposerDraftKey(selectedThreadShell);
      const insertion = captureComposerDraftInsertion(threadKey);
      try {
        const images = await convertPastedImagesToAttachments({
          uris,
          existingCount: countComposerDraftAttachmentsAfterSelection(threadKey, insertion),
        });
        if (images.length > 0) {
          appendComposerDraftAttachments(threadKey, images, { appendReference: true, insertion });
        }
      } catch (error) {
        console.error("[native paste] error converting images", {
          environmentId: selectedThreadShell.environmentId,
          threadId: selectedThreadShell.id,
          uriCount: uris.length,
          ...safeErrorLogAttributes(error),
        });
      }
    },
    [composerDrafts, selectedThreadShell],
  );

  const onNativePasteText = useCallback(
    async (paste: ComposerTextPaste) => {
      if (!selectedThreadShell) return;
      const capabilities = selectedEnvironmentRuntime?.serverConfig?.environment.capabilities;
      const advertisedMax =
        capabilities?.attachmentUploads === true
          ? capabilities.fileAttachments?.maxUploadBytes
          : undefined;
      if (advertisedMax === undefined) return;

      const threadKey = activeComposerDraftKey(selectedThreadShell);
      const insertion = { text: paste.value, ...paste.selection };
      const currentAttachments = getComposerDraftSnapshot(threadKey).attachments;
      try {
        const attachment = await createPastedTextComposerAttachment({
          text: paste.text,
          name: reservePastedTextFileName(
            threadKey,
            currentAttachments.map((item) => item.name),
          ),
          maxBytes: clampFileAttachmentUploadBytes(advertisedMax),
        });
        const rejectedCount = appendComposerDraftAttachments(threadKey, [attachment], {
          appendReference: true,
          insertion,
        });
        if (rejectedCount > 0) {
          await removePersistedComposerAttachmentFile(attachment.fileUri);
          setPendingConnectionError(
            `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
          );
        }
      } catch (error) {
        setPendingConnectionError(
          error instanceof Error ? error.message : "Could not attach pasted text.",
        );
      }
    },
    [
      composerDrafts,
      reservePastedTextFileName,
      selectedEnvironmentRuntime?.serverConfig,
      selectedThreadShell,
    ],
  );

  const onRemoveDraftImage = useCallback(
    (imageId: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = activeComposerDraftKey(selectedThreadShell);
      removeComposerDraftAttachment(threadKey, imageId);
    },
    [selectedThreadShell],
  );

  const onUpdateModelSelection = useCallback(
    (value: ModelSelection) => {
      if (!selectedThreadKey) {
        return;
      }
      const provider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
        (candidate) => candidate.instanceId === value.instanceId,
      );
      updateComposerDraftSettings(selectedThreadKey, {
        modelSelection: value,
        ...(provider?.showInteractionModeToggle === false
          ? { interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE }
          : {}),
      });
    },
    [selectedEnvironmentRuntime?.serverConfig, selectedThreadKey],
  );

  const onUpdateRuntimeMode = useCallback(
    (value: RuntimeMode) => {
      if (!selectedThreadKey) {
        return;
      }
      updateComposerDraftSettings(selectedThreadKey, { runtimeMode: value });
    },
    [selectedThreadKey],
  );

  const onUpdateInteractionMode = useCallback(
    (value: ProviderInteractionMode) => {
      if (!selectedThreadKey) {
        return;
      }
      const modelSelection =
        getComposerDraftSnapshot(selectedThreadKey).modelSelection ??
        selectedThread?.modelSelection;
      const provider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
        (candidate) => candidate.instanceId === modelSelection?.instanceId,
      );
      updateComposerDraftSettings(selectedThreadKey, {
        interactionMode: resolveProviderInteractionMode(provider, value),
      });
    },
    [selectedEnvironmentRuntime?.serverConfig, selectedThread?.modelSelection, selectedThreadKey],
  );

  return {
    feedbackSubmissions,
    dismissFeedback,
    selectedThreadFeed,
    supportsThreadConversations,
    conversations,
    selectedConversationId,
    setSelectedConversationId,
    onCreateConversation,
    onRenameConversation,
    onUpdateConversationState,
    onAssignLatestExchange,
    selectedThreadActivityRun,
    selectedThreadQueueCount,
    selectedThreadQueuedMessages: visibleQueuedMessages,
    dispatchingQueuedMessageId,
    activeWorkStartedAt,
    runlessWorkActive,
    providerSubagentStatus,
    isCompacting,
    draftMessage,
    draftAttachments,
    composerDraftKey,
    followUpBehavior,
    canSteerActiveTurn,
    queuedRunEdit,
    isSavingQueuedEdit,
    cancelQueuedRunEdit,
    onRemoveQueuedEditAttachment,
    modelSelection,
    pendingHandoff,
    canSwitchThreadProvider,
    runtimeMode,
    interactionMode,
    activeThreadBusy,
    interruptibleRunId,
    onChangeDraftMessage,
    onPickDraftMedia,
    onPickDraftFiles,
    onPasteIntoDraft,
    onNativePasteImages,
    onNativePasteText,
    onRemoveDraftImage,
    onSendMessage,
    onStartMultitask,
    onUpdateModelSelection,
    onUpdateRuntimeMode,
    onUpdateInteractionMode,
  };
}
