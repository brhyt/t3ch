import {
  ThreadConversationId,
  type MessageId,
  type ThreadConversation,
  type ThreadConversationMutation,
  type ThreadConversationState,
} from "@t3tools/contracts";
import {
  sortThreadConversations,
  threadConversationStatusLabel,
} from "@t3tools/client-runtime/thread-conversations";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleHelpIcon,
  Clock3Icon,
  ListFilterIcon,
  MessageCircleMoreIcon,
  PencilIcon,
  PlusIcon,
} from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { randomUUID } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface AssignableConversationExchange {
  readonly id: MessageId;
  readonly text: string;
  readonly conversationIds: ReadonlyArray<ThreadConversationId>;
}

interface ConversationEditorDraft {
  readonly id: ThreadConversationId | null;
  readonly title: string;
  readonly goal: string;
  readonly state: ThreadConversationState;
  readonly detail: string;
  readonly sourceMessageId?: MessageId;
}

const DEFAULT_STATE: ThreadConversationState = { status: "active" };

function stateIcon(state: ThreadConversationState) {
  switch (state.status) {
    case "decision_needed":
      return <CircleHelpIcon />;
    case "active":
      return <MessageCircleMoreIcon />;
    case "waiting":
      return <Clock3Icon />;
    case "completed":
      return <CheckIcon />;
  }
}

function statusLabel(status: ThreadConversationState["status"]) {
  switch (status) {
    case "decision_needed":
      return "Decision needed";
    case "active":
      return "Active";
    case "waiting":
      return "Waiting";
    case "completed":
      return "Completed";
  }
}

function stateForStatus(
  status: ThreadConversationState["status"],
  detail: string,
  sourceMessageId?: MessageId,
): ThreadConversationState {
  switch (status) {
    case "decision_needed":
      return {
        status,
        question: detail.trim() || "What decision is needed?",
        ...(sourceMessageId === undefined ? {} : { sourceMessageId }),
      };
    case "active":
      return { status };
    case "waiting":
      return { status, reason: detail.trim() || "Waiting for input" };
    case "completed":
      return { status };
  }
}

function editorDraft(conversation: ThreadConversation | null): ConversationEditorDraft {
  return conversation === null
    ? { id: null, title: "", goal: "", state: DEFAULT_STATE, detail: "" }
    : {
        id: conversation.id,
        title: conversation.title,
        goal: conversation.goal ?? "",
        state: conversation.state,
        detail: stateDetail(conversation.state),
        ...(conversation.state.status === "decision_needed" && conversation.state.sourceMessageId
          ? { sourceMessageId: conversation.state.sourceMessageId }
          : {}),
      };
}

function stateDetail(state: ThreadConversationState): string {
  switch (state.status) {
    case "decision_needed":
      return state.question;
    case "waiting":
      return state.reason;
    case "active":
    case "completed":
      return "";
  }
}

function ConversationEditor(props: {
  readonly draft: ConversationEditorDraft;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSave: (draft: ConversationEditorDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState(props.draft);
  const detailLabel = draft.state.status === "decision_needed" ? "Decision needed" : "Waiting for";
  const detailRequired =
    draft.state.status === "decision_needed" || draft.state.status === "waiting";

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{draft.id === null ? "New conversation" : "Edit conversation"}</DialogTitle>
          <DialogDescription>
            Group related exchanges while the agent keeps the complete thread context.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-1.5">
            <Label htmlFor="conversation-title">Title</Label>
            <Input
              id="conversation-title"
              autoFocus
              maxLength={120}
              value={draft.title}
              onValueChange={(title) => setDraft({ ...draft, title })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="conversation-goal">Goal</Label>
            <Textarea
              id="conversation-goal"
              maxLength={500}
              size="sm"
              placeholder="What should this conversation resolve?"
              value={draft.goal}
              onChange={(event) => setDraft({ ...draft, goal: event.currentTarget.value })}
            />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Status</legend>
            <div className="flex flex-wrap gap-1.5">
              {(["decision_needed", "active", "waiting", "completed"] as const).map((status) => (
                <Button
                  key={status}
                  type="button"
                  size="xs"
                  variant={draft.state.status === status ? "secondary" : "outline"}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      state: stateForStatus(status, draft.detail, draft.sourceMessageId),
                    })
                  }
                >
                  {statusLabel(status)}
                </Button>
              ))}
            </div>
          </fieldset>
          {(draft.state.status === "decision_needed" || draft.state.status === "waiting") && (
            <div className="space-y-1.5">
              <Label htmlFor="conversation-state-detail">{detailLabel}</Label>
              <Input
                id="conversation-state-detail"
                maxLength={500}
                value={draft.detail}
                onValueChange={(detail) => setDraft({ ...draft, detail })}
              />
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={
              props.busy ||
              draft.title.trim().length === 0 ||
              (detailRequired && draft.detail.trim().length === 0)
            }
            onClick={() => void props.onSave(draft)}
          >
            {props.busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function AssignExchangeDialog(props: {
  readonly conversations: ReadonlyArray<ThreadConversation>;
  readonly exchanges: ReadonlyArray<AssignableConversationExchange>;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onAssign: (
    messageId: MessageId,
    conversationIds: ReadonlyArray<ThreadConversationId>,
  ) => Promise<void>;
}) {
  const initialExchange = props.exchanges.at(-1);
  const [messageId, setMessageId] = useState<MessageId | null>(initialExchange?.id ?? null);
  const [conversationIds, setConversationIds] = useState<ReadonlyArray<ThreadConversationId>>(
    initialExchange?.conversationIds ?? [],
  );

  const selectExchange = (exchange: AssignableConversationExchange) => {
    setMessageId(exchange.id);
    setConversationIds(exchange.conversationIds);
  };

  const toggleConversation = (conversationId: ThreadConversationId) => {
    setConversationIds((current) =>
      current.includes(conversationId)
        ? current.filter((id) => id !== conversationId)
        : [...current, conversationId],
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Assign an exchange</DialogTitle>
          <DialogDescription>
            Choose a user message. Its response and tool activity follow it into the conversation.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-2">
            <div className="text-sm font-medium">Exchange</div>
            <div className="max-h-48 space-y-1 overflow-y-auto">
              {props.exchanges.toReversed().map((exchange) => (
                <button
                  key={exchange.id}
                  type="button"
                  aria-pressed={messageId === exchange.id}
                  onClick={() => selectExchange(exchange)}
                  className="flex w-full rounded-lg border border-transparent px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none aria-pressed:border-border aria-pressed:bg-accent"
                >
                  <span className="line-clamp-2">{exchange.text || "Attachment-only message"}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <div className="text-sm font-medium">Conversation</div>
            <div className="flex flex-wrap gap-1.5">
              {props.conversations.map((conversation) => (
                <Button
                  key={conversation.id}
                  type="button"
                  size="xs"
                  variant={conversationIds.includes(conversation.id) ? "secondary" : "outline"}
                  aria-pressed={conversationIds.includes(conversation.id)}
                  onClick={() => toggleConversation(conversation.id)}
                >
                  {conversation.title}
                </Button>
              ))}
              <Button
                type="button"
                size="xs"
                variant={conversationIds.length === 0 ? "secondary" : "outline"}
                aria-pressed={conversationIds.length === 0}
                onClick={() => setConversationIds([])}
              >
                Unassigned
              </Button>
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={props.busy || messageId === null}
            onClick={() =>
              messageId === null ? undefined : void props.onAssign(messageId, conversationIds)
            }
          >
            {props.busy ? "Assigning…" : "Assign"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function ThreadConversationsBar(props: {
  readonly conversations: ReadonlyArray<ThreadConversation>;
  readonly selectedId: ThreadConversationId | null;
  readonly exchanges: ReadonlyArray<AssignableConversationExchange>;
  readonly canManage: boolean;
  readonly error: string | null;
  readonly onSelect: (conversationId: ThreadConversationId | null) => void;
  readonly onMutate: (mutation: ThreadConversationMutation) => Promise<boolean>;
  readonly onOpenEvidence: (messageId: MessageId) => void;
}) {
  const conversations = useMemo(
    () => sortThreadConversations(props.conversations),
    [props.conversations],
  );
  const selected =
    conversations.find((conversation) => conversation.id === props.selectedId) ?? null;
  const [editor, setEditor] = useState<ConversationEditorDraft | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const selectedButtonRef = useRef<HTMLButtonElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pillNodesRef = useRef(new Map<ThreadConversationId, HTMLButtonElement>());
  const previousPillPositionsRef = useRef(new Map<ThreadConversationId, number>());
  useLayoutEffect(() => {
    const nextPositions = new Map<ThreadConversationId, number>();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const conversation of conversations) {
      const node = pillNodesRef.current.get(conversation.id);
      if (!node) continue;
      const left = node.getBoundingClientRect().left;
      nextPositions.set(conversation.id, left);
      const previousLeft = previousPillPositionsRef.current.get(conversation.id);
      if (!reducedMotion && previousLeft !== undefined && previousLeft !== left) {
        node.animate(
          [{ transform: `translateX(${previousLeft - left}px)` }, { transform: "translateX(0)" }],
          { duration: 180, easing: "ease-out" },
        );
      }
    }
    previousPillPositionsRef.current = nextPositions;
    const button = selectedButtonRef.current;
    if (!button) return;
    button.scrollIntoView({
      behavior: reducedMotion ? "auto" : "smooth",
      block: "nearest",
      inline: "nearest",
    });
  }, [conversations]);

  const scrollPills = (direction: -1 | 1) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scroller.scrollBy({
      left: direction * Math.min(240, scroller.clientWidth * 0.75),
      behavior: reducedMotion ? "auto" : "smooth",
    });
  };

  const saveEditor = async (draft: ConversationEditorDraft) => {
    setBusy(true);
    const state = stateForStatus(draft.state.status, draft.detail, draft.sourceMessageId);
    const success = await props.onMutate(
      draft.id === null
        ? {
            type: "create",
            id: ThreadConversationId.make(randomUUID()),
            title: draft.title.trim(),
            ...(draft.goal.trim() ? { goal: draft.goal.trim() } : {}),
            state,
          }
        : {
            type: "update",
            id: draft.id,
            title: draft.title.trim(),
            goal: draft.goal.trim() || null,
            state,
          },
    );
    setBusy(false);
    if (success) setEditor(null);
  };

  const assign = async (
    messageId: MessageId,
    conversationIds: ReadonlyArray<ThreadConversationId>,
  ) => {
    setBusy(true);
    const success = await props.onMutate({
      type: "assign",
      messageIds: [messageId],
      conversationIds,
    });
    setBusy(false);
    if (success) setAssignOpen(false);
  };

  const reopen = async (conversationId: ThreadConversationId) => {
    setBusy(true);
    await props.onMutate({ type: "update", id: conversationId, state: { status: "active" } });
    setBusy(false);
  };

  return (
    <section
      className="shrink-0 border-b border-border/60 bg-background"
      aria-label="Thread conversations"
    >
      <div className="flex min-w-0 items-center gap-1.5 px-(--workspace-gutter-start) py-1.5 pr-(--workspace-gutter-end)">
        <button
          ref={props.selectedId === null ? selectedButtonRef : undefined}
          type="button"
          aria-pressed={props.selectedId === null}
          onClick={() => props.onSelect(null)}
          className="z-10 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-xs font-medium text-muted-foreground shadow-xs transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none aria-pressed:border-foreground/20 aria-pressed:bg-foreground aria-pressed:text-background"
        >
          <ListFilterIcon className="size-3.5" />
          Full
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Scroll conversations left"
          onClick={() => scrollPills(-1)}
        >
          <ChevronLeftIcon />
        </Button>
        <div
          ref={scrollerRef}
          className="min-w-0 flex-1 overflow-x-auto scroll-smooth [scrollbar-width:none] motion-reduce:scroll-auto [&::-webkit-scrollbar]:hidden"
        >
          <div className="flex w-max items-center gap-1.5 pr-2">
            {conversations.map((conversation) => (
              <Tooltip key={conversation.id}>
                <TooltipTrigger
                  render={
                    <button
                      ref={(node) => {
                        if (node) pillNodesRef.current.set(conversation.id, node);
                        else pillNodesRef.current.delete(conversation.id);
                        if (props.selectedId === conversation.id) selectedButtonRef.current = node;
                      }}
                      type="button"
                      aria-pressed={props.selectedId === conversation.id}
                      aria-label={`${conversation.title}, ${threadConversationStatusLabel(conversation.state)}`}
                      onClick={() => props.onSelect(conversation.id)}
                      className="inline-flex h-7 max-w-56 shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-background px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none aria-pressed:border-primary/25 aria-pressed:bg-primary/10 aria-pressed:text-foreground"
                    />
                  }
                >
                  <span className="[&_svg]:size-3.5 [&_svg]:shrink-0">
                    {stateIcon(conversation.state)}
                  </span>
                  <span className="truncate">{conversation.title}</span>
                </TooltipTrigger>
                <TooltipPopup side="top">
                  {conversation.title} · {threadConversationStatusLabel(conversation.state)}
                </TooltipPopup>
              </Tooltip>
            ))}
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Scroll conversations right"
          onClick={() => scrollPills(1)}
        >
          <ChevronRightIcon />
        </Button>
        {props.canManage && (
          <div className="flex shrink-0 items-center gap-0.5">
            {props.selectedId === null && conversations.length > 0 && props.exchanges.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Assign an exchange"
                onClick={() => setAssignOpen(true)}
              >
                <ListFilterIcon />
              </Button>
            ) : null}
            {selected ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Edit ${selected.title}`}
                onClick={() => setEditor(editorDraft(selected))}
              >
                <PencilIcon />
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Create conversation"
              onClick={() => setEditor(editorDraft(null))}
            >
              <PlusIcon />
            </Button>
          </div>
        )}
      </div>
      {selected ? (
        <div className="flex min-h-7 items-start gap-2 border-t border-border/40 px-(--workspace-gutter-start) py-1.5 pr-(--workspace-gutter-end) text-xs text-muted-foreground">
          <span className="shrink-0 font-medium text-foreground">
            {threadConversationStatusLabel(selected.state)}
          </span>
          <span className="min-w-0 truncate">
            {selected.state.status === "decision_needed"
              ? selected.state.question
              : selected.state.status === "waiting"
                ? selected.state.reason
                : selected.goal || "This view shows only exchanges assigned to this conversation."}
          </span>
          {selected.state.status === "completed" && props.canManage ? (
            <button
              type="button"
              disabled={busy}
              className="shrink-0 font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50"
              onClick={() => void reopen(selected.id)}
            >
              Reopen
            </button>
          ) : null}
          {selected.state.status === "decision_needed" && selected.state.sourceMessageId ? (
            <button
              type="button"
              className="shrink-0 font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() =>
                selected.state.status === "decision_needed" && selected.state.sourceMessageId
                  ? props.onOpenEvidence(selected.state.sourceMessageId)
                  : undefined
              }
            >
              Evidence
            </button>
          ) : null}
          <button
            type="button"
            className="shrink-0 font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={() => props.onSelect(null)}
          >
            Full timeline
          </button>
        </div>
      ) : null}
      {props.error ? (
        <div
          role="alert"
          className="border-t border-destructive/20 bg-destructive/5 px-(--workspace-gutter-start) py-1.5 pr-(--workspace-gutter-end) text-xs text-destructive"
        >
          {props.error}
        </div>
      ) : null}
      {editor ? (
        <ConversationEditor
          key={editor.id ?? "create"}
          draft={editor}
          busy={busy}
          onClose={() => setEditor(null)}
          onSave={saveEditor}
        />
      ) : null}
      {assignOpen ? (
        <AssignExchangeDialog
          conversations={conversations}
          exchanges={props.exchanges}
          busy={busy}
          onClose={() => setAssignOpen(false)}
          onAssign={assign}
        />
      ) : null}
    </section>
  );
}
