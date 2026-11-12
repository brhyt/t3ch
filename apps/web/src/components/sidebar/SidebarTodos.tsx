import { useAtomValue } from "@effect/atom-react";
import { CommandId, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadConversationStatusLabel } from "@t3tools/client-runtime/thread-conversations";
import {
  nextThreadTodo,
  threadTodoDetail,
  type ThreadTodo,
} from "@t3tools/client-runtime/thread-todos";
import {
  CheckIcon,
  CircleHelpIcon,
  Clock3Icon,
  MessageCircleMoreIcon,
  SkipForwardIcon,
} from "lucide-react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { cn, randomUUID } from "~/lib/utils";
import { type SidebarListView, useThreadTopicFocusStore } from "../../sidebarTodosStore";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface SidebarMachineOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

const ALL_MACHINES = "all";

/** Threads | To-dos, plus the machine filter once more than one machine is connected. */
export function SidebarViewBar(props: {
  readonly view: SidebarListView;
  readonly onViewChange: (view: SidebarListView) => void;
  readonly todoCount: number;
  readonly machines: ReadonlyArray<SidebarMachineOption>;
  readonly machineEnvironmentId: EnvironmentId | null;
  readonly onMachineChange: (environmentId: EnvironmentId | null) => void;
}) {
  const labelByValue = new Map<string, string>([
    [ALL_MACHINES, "All machines"],
    ...props.machines.map((machine) => [machine.environmentId, machine.label] as const),
  ]);
  return (
    <div className="flex items-center gap-1 px-1 pt-1">
      <ToggleGroup
        aria-label="Sidebar list"
        value={[props.view]}
        onValueChange={(next) => {
          const value = next[0];
          if (value === "threads" || value === "todos") props.onViewChange(value);
        }}
      >
        <Toggle value="threads">Threads</Toggle>
        <Toggle value="todos">To-dos{props.todoCount > 0 ? ` ${props.todoCount}` : ""}</Toggle>
      </ToggleGroup>
      {props.machines.length > 1 ? (
        <div className="ml-auto min-w-0">
          <Select
            value={props.machineEnvironmentId ?? ALL_MACHINES}
            onValueChange={(value) => {
              if (value === null) return;
              props.onMachineChange(value === ALL_MACHINES ? null : (value as EnvironmentId));
            }}
          >
            <SelectTrigger size="xs" variant="ghost" aria-label="Filter sidebar by machine">
              <SelectValue>
                {(value: string) => labelByValue.get(value) ?? "All machines"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value={ALL_MACHINES}>All machines</SelectItem>
              {props.machines.map((machine) => (
                <SelectItem key={machine.environmentId} value={machine.environmentId}>
                  {machine.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      ) : null}
    </div>
  );
}

function TodoStateIcon(props: { readonly todo: ThreadTodo }) {
  switch (props.todo.conversation.state.status) {
    case "decision_needed":
      return <CircleHelpIcon className="size-3.5 text-warning" aria-hidden />;
    case "waiting":
      return <Clock3Icon className="size-3.5 text-sidebar-muted-foreground" aria-hidden />;
    case "active":
    case "completed":
      return (
        <MessageCircleMoreIcon className="size-3.5 text-sidebar-muted-foreground" aria-hidden />
      );
  }
}

// Subscribes to the minute tick itself, so only the label re-renders each minute.
function TodoTime(props: { readonly timestamp: string }) {
  const nowMinute = useNowMinute();
  return (
    <span className="shrink-0 text-2xs text-sidebar-muted-foreground">
      {formatRelativeTimeLabel(props.timestamp, Date.parse(`${nowMinute}:00.000Z`))}
    </span>
  );
}

function SidebarTodoRow(props: {
  readonly todo: ThreadTodo;
  readonly isCurrent: boolean;
  readonly context: string;
  readonly onOpen: (todo: ThreadTodo) => void;
}) {
  const { todo } = props;
  const canMarkDone = useAtomValue(
    orchestrationEnvironment.v2.dispatchCommand.permissionAtom(todo.environmentId),
  );
  const dispatch = useAtomCommand(orchestrationEnvironment.v2.dispatchCommand, {
    label: "Mark to-do done",
  });
  const detail = threadTodoDetail(todo.conversation);
  const markDone = () =>
    void dispatch({
      environmentId: todo.environmentId,
      input: {
        type: "thread.metadata.update",
        commandId: CommandId.make(randomUUID()),
        threadId: todo.threadId,
        conversationMutation: {
          type: "update",
          id: todo.conversation.id,
          state: { status: "completed" },
        },
      },
    });
  return (
    <li className="group/todo relative">
      <button
        type="button"
        aria-current={props.isCurrent ? "true" : undefined}
        aria-label={`${todo.conversation.title}, ${threadConversationStatusLabel(todo.conversation.state)}, in ${todo.threadTitle}`}
        onClick={() => props.onOpen(todo)}
        className={cn(
          "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 pr-8 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.isCurrent
            ? "bg-sidebar-row-active text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
            : "text-sidebar-foreground hover:bg-sidebar-row-hover",
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5 text-sm">
          <TodoStateIcon todo={todo} />
          <span className="min-w-0 flex-1 truncate font-medium">{todo.conversation.title}</span>
          <TodoTime timestamp={todo.conversation.updatedAt} />
        </span>
        {detail ? (
          <span className="line-clamp-2 text-xs text-sidebar-foreground/80">{detail}</span>
        ) : null}
        <span className="truncate text-2xs text-sidebar-muted-foreground">{props.context}</span>
      </button>
      {canMarkDone ? (
        <div className="absolute top-1 right-1 opacity-0 group-hover/todo:opacity-100 group-focus-within/todo:opacity-100 pointer-coarse:opacity-100">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`Mark ${todo.conversation.title} done`}
                  onClick={markDone}
                />
              }
            >
              <CheckIcon />
            </TooltipTrigger>
            <TooltipPopup side="top">Mark done</TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
    </li>
  );
}

/** Open topics across threads and machines, worked down one by one. */
export function SidebarTodoList(props: {
  readonly todos: ReadonlyArray<ThreadTodo>;
  readonly routeThreadKey: string | null;
  readonly projectLabelByKey: ReadonlyMap<string, string>;
  /** Set when more than one machine is connected, so rows name theirs. */
  readonly environmentLabelById: ReadonlyMap<EnvironmentId, string> | null;
  readonly onOpenThread: (threadRef: ScopedThreadRef) => void;
}) {
  const focusedByThreadKey = useThreadTopicFocusStore((store) => store.byThreadKey);
  const focus = useThreadTopicFocusStore((store) => store.focus);
  const currentKey =
    props.routeThreadKey === null
      ? null
      : (props.todos.find(
          (todo) =>
            todo.threadKey === props.routeThreadKey &&
            focusedByThreadKey[todo.threadKey] === todo.conversation.id,
        )?.key ?? null);
  const open = (todo: ThreadTodo) => {
    focus(todo.threadKey, todo.conversation.id);
    props.onOpenThread(scopeThreadRef(todo.environmentId, todo.threadId));
  };
  const next = nextThreadTodo(props.todos, currentKey);

  if (props.todos.length === 0) {
    return (
      <p role="status" className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground">
        No open to-dos
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between px-2 pt-1">
        <span className="text-xs text-sidebar-muted-foreground">{props.todos.length} open</span>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={next === null}
          onClick={() => (next === null ? undefined : open(next))}
        >
          <SkipForwardIcon />
          Next
        </Button>
      </div>
      <ul aria-label="Open to-dos" className="flex flex-col gap-px">
        {props.todos.map((todo) => {
          const project =
            props.projectLabelByKey.get(`${todo.environmentId}:${todo.projectId}`) ?? null;
          const machine = props.environmentLabelById?.get(todo.environmentId) ?? null;
          return (
            <SidebarTodoRow
              key={todo.key}
              todo={todo}
              isCurrent={todo.key === currentKey}
              context={[todo.threadTitle, project, machine].filter(Boolean).join(" · ")}
              onOpen={open}
            />
          );
        })}
      </ul>
    </div>
  );
}
