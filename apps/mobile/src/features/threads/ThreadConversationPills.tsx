import { threadConversationStatusLabel } from "@t3tools/client-runtime/thread-conversations";
import type {
  ThreadConversation,
  ThreadConversationId,
  ThreadConversationState,
} from "@t3tools/contracts";
import { Pressable, ScrollView, View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { AppText } from "../../components/ui/AppText";
import { Chip } from "../../components/ui/Chip";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";

export interface ThreadConversationPillsProps {
  readonly conversations: readonly ThreadConversation[];
  readonly selectedId: ThreadConversationId | null;
  readonly canEdit: boolean;
  readonly onSelect: (id: ThreadConversationId | null) => void;
  readonly onCreate: (title: string) => Promise<void>;
  readonly onRename: (id: ThreadConversationId, title: string) => Promise<void>;
  readonly onUpdateState: (
    id: ThreadConversationId,
    state: ThreadConversationState,
  ) => Promise<void>;
  readonly onAssignLatest: (id: ThreadConversationId) => Promise<void>;
}

function ConversationPill(props: {
  readonly conversation: ThreadConversation;
  readonly selected: boolean;
  readonly canEdit: boolean;
  readonly onSelect: () => void;
  readonly onRename: (title: string) => Promise<void>;
  readonly onUpdateState: (state: ThreadConversationState) => Promise<void>;
  readonly onAssignLatest: () => Promise<void>;
}) {
  const { conversation } = props;
  const updateState = (status: "active" | "decision_needed" | "waiting" | "completed") => {
    if (status === "decision_needed") {
      Dialog.prompt({
        title: "Decision needed",
        initialValue:
          conversation.state.status === "decision_needed" ? conversation.state.question : "",
        confirmText: "Save",
        onConfirm: (question) => {
          const detail = question.trim().slice(0, 2_000);
          if (detail) void props.onUpdateState({ status, question: detail });
        },
      });
      return;
    }
    if (status === "waiting") {
      Dialog.prompt({
        title: "Waiting for",
        initialValue: conversation.state.status === "waiting" ? conversation.state.reason : "",
        confirmText: "Save",
        onConfirm: (reason) => {
          const detail = reason.trim().slice(0, 2_000);
          if (detail) void props.onUpdateState({ status, reason: detail });
        },
      });
      return;
    }
    void props.onUpdateState({ status });
  };

  return (
    <Menu
      accessibilityLabel={`Conversation ${conversation.title}`}
      shouldOpenOnLongPress={props.canEdit}
      actions={
        props.canEdit
          ? [
              { id: "rename", title: "Rename" },
              { id: "assign-latest", title: "Add latest exchange" },
              {
                id: "active",
                title: conversation.state.status === "completed" ? "Reopen" : "Active",
              },
              { id: "decision_needed", title: "Decision needed" },
              { id: "waiting", title: "Waiting" },
              { id: "completed", title: "Completed" },
            ]
          : []
      }
      onPressAction={({ nativeEvent }) => {
        switch (nativeEvent.event) {
          case "rename":
            Dialog.prompt({
              title: "Conversation title",
              initialValue: conversation.title,
              confirmText: "Save",
              onConfirm: (title) => {
                const next = title.trim().slice(0, 120);
                if (next) void props.onRename(next);
              },
            });
            return;
          case "assign-latest":
            void props.onAssignLatest();
            return;
          case "active":
          case "decision_needed":
          case "waiting":
          case "completed":
            updateState(nativeEvent.event);
        }
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${conversation.title}, ${threadConversationStatusLabel(conversation.state)}`}
        accessibilityState={{ selected: props.selected }}
        onPress={props.onSelect}
        className="active:opacity-70"
      >
        <View
          className={cn(
            "min-h-8 flex-row items-center gap-1.5 rounded-2xl px-3 py-1.5",
            props.selected ? "bg-primary" : "bg-subtle",
          )}
        >
          <AppText
            textRole="footnote"
            numberOfLines={1}
            className={cn(
              "max-w-[180px] shrink font-t3-medium",
              props.selected ? "text-primary-foreground" : "text-foreground-muted",
            )}
          >
            {conversation.title}
          </AppText>
          <AppText
            textRole="caption"
            className={props.selected ? "text-primary-foreground/75" : "text-foreground-subtle"}
          >
            {threadConversationStatusLabel(conversation.state)}
          </AppText>
        </View>
      </Pressable>
    </Menu>
  );
}

export function ThreadConversationPills(props: ThreadConversationPillsProps) {
  return (
    <View className="flex-row items-center gap-2 border-b border-border px-3 py-2">
      <Chip
        label="Full"
        selected={props.selectedId === null}
        onPress={() => props.onSelect(null)}
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="items-center gap-2 pr-3"
      >
        {props.conversations.map((conversation) => (
          <ConversationPill
            key={conversation.id}
            conversation={conversation}
            selected={props.selectedId === conversation.id}
            canEdit={props.canEdit}
            onSelect={() => props.onSelect(conversation.id)}
            onRename={(title) => props.onRename(conversation.id, title)}
            onUpdateState={(state) => props.onUpdateState(conversation.id, state)}
            onAssignLatest={() => props.onAssignLatest(conversation.id)}
          />
        ))}
        {props.canEdit ? (
          <Chip
            label="New"
            icon="plus"
            accessibilityLabel="Create conversation"
            onPress={() =>
              Dialog.prompt({
                title: "New conversation",
                initialValue: "",
                confirmText: "Create",
                onConfirm: (title) => {
                  const next = title.trim().slice(0, 120);
                  if (next) void props.onCreate(next);
                },
              })
            }
          />
        ) : null}
      </ScrollView>
    </View>
  );
}
