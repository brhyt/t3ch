import type { ScopedThreadRef, ServerProviderSkill } from "@t3tools/contracts";
import type { ProviderInstanceEntry } from "~/providerInstances";
import type { ChatMessage } from "~/types";
import { useWorkflowStore } from "~/workflowStore";
import {
  readWorkflowContext,
  workflowBlockReason,
  workflowRoles,
  workflowSkills,
} from "~/workflowConfig";
import { useThreadProjection } from "~/state/entities";
import { Bot, PanelBottom, Workflow } from "lucide-react";
import { Select, SelectItem, SelectPopup, SelectValue } from "~/components/ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { ComposerControl, ComposerControlIcon, ComposerSelectControl } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";

type Props = {
  threadKey: string;
  threadRef?: ScopedThreadRef | null;
  skills: readonly ServerProviderSkill[];
  providers: readonly ProviderInstanceEntry[];
  disabled?: boolean;
};

export function WorkflowDrawerToggle(props: {
  expanded: boolean;
  drawerId: string;
  onToggle: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            aria-label="Toggle workflow drawer"
            aria-expanded={props.expanded}
            aria-controls={props.drawerId}
            aria-pressed={props.expanded}
            onClick={props.onToggle}
          />
        }
      >
        <ComposerControlIcon icon={PanelBottom} />
      </TooltipTrigger>
      <TooltipPopup side="top">
        {props.expanded ? "Hide workflow controls" : "Show workflow controls"}
      </TooltipPopup>
    </Tooltip>
  );
}

export function WorkflowSelector(props: Props & { onOpen: () => void }) {
  const selected = useWorkflowStore((state) => state.byThread[props.threadKey] ?? null);
  const projection = useThreadProjection(props.threadRef ?? null)?.projection;
  const activeRun = projection?.runs.findLast(
    (run) => run.status === "running" || run.status === "waiting" || run.status === "starting",
  );
  const activeMessage = activeRun
    ? projection?.messages.find((message) => message.id === activeRun.userMessageId)
    : undefined;
  const activeWorkflow = activeMessage ? readWorkflowContext(activeMessage.text) : null;
  const runningAgents = activeRun
    ? (projection?.subagents.filter(
        (task) => task.runId === activeRun.id && task.status === "running",
      ).length ?? 0)
    : 0;
  const menuProps = useComposerMenuProps();
  const skills = workflowSkills(props.skills);
  const reason = workflowBlockReason(selected, props.skills, props.providers);
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs">
      <Tooltip>
        <Select
          disabled={props.disabled}
          value={selected?.skillPath ?? ""}
          onValueChange={(value) => {
            const skill = skills.find((entry) => entry.path === value);
            useWorkflowStore
              .getState()
              .select(
                props.threadKey,
                skill ? { skillName: skill.name, skillPath: skill.path, assignments: {} } : null,
              );
          }}
        >
          <TooltipTrigger render={<ComposerSelectControl aria-label="Workflow for next turn" />}>
            <ComposerControlIcon icon={Workflow} />
            <span className="max-w-48 truncate">
              <SelectValue data-composer-control-label>
                {selected
                  ? (skills.find((skill) => skill.path === selected.skillPath)?.displayName ??
                    selected.skillName)
                  : "Workflow"}
              </SelectValue>
            </span>
          </TooltipTrigger>
          <SelectPopup alignItemWithTrigger={false} matchTriggerWidth={false} {...menuProps}>
            <SelectItem value="">No workflow</SelectItem>
            {selected && !skills.some((skill) => skill.path === selected.skillPath) && (
              <SelectItem value={selected.skillPath} disabled>
                {selected.skillName} · unavailable
              </SelectItem>
            )}
            {skills.map((skill) => (
              <SelectItem
                key={skill.path}
                value={skill.path}
                disabled={
                  !skill.enabled || skill.userInvocable === false || skill.userInvocationOnly
                }
              >
                {skill.displayName ?? skill.name}
                {!skill.enabled
                  ? " · disabled"
                  : skill.userInvocationOnly
                    ? " · use slash command"
                    : ""}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <TooltipPopup side="top">Workflow for your next turn</TooltipPopup>
      </Tooltip>
      {activeWorkflow && (
        <span className="text-muted-foreground">
          Current turn: {activeWorkflow.skillName} · {activeRun?.status} · {runningAgents} agents
          running
        </span>
      )}
      <Tooltip>
        <TooltipTrigger
          render={<ComposerControl aria-label="Configure workflow agents" onClick={props.onOpen} />}
        >
          <ComposerControlIcon icon={Bot} />
        </TooltipTrigger>
        <TooltipPopup side="top">Configure workflow agents</TooltipPopup>
      </Tooltip>
      {reason && (
        <p role="status" className="w-full text-destructive">
          {reason}
        </p>
      )}
    </div>
  );
}

export function WorkflowPanel(
  props: Props & { threadRef: ScopedThreadRef; messages: readonly ChatMessage[] },
) {
  const selected = useWorkflowStore((state) => state.byThread[props.threadKey] ?? null);
  const projection = useThreadProjection(props.threadRef)?.projection;
  const applied = props.messages
    .filter((message) => message.role === "user")
    .flatMap((message) => {
      const config = readWorkflowContext(message.text);
      return config ? [{ message, config }] : [];
    });
  const latest = applied.at(-1);
  const tasks = latest?.message.runId
    ? (projection?.subagents.filter((task) => task.runId === latest.message.runId) ?? [])
    : [];
  const installed = workflowSkills(props.skills);
  const chosenSkill = props.skills.find((skill) => skill.path === selected?.skillPath);
  const reason = workflowBlockReason(selected, props.skills, props.providers);
  return (
    <section
      aria-label="Workflow"
      className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4 text-sm"
    >
      <div>
        <h2 className="font-medium">Next turn</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Changes apply to your next message. Running and queued turns keep the instructions they
          were sent with. Workflow preferences are saved on this client.
        </p>
      </div>
      <WorkflowSelector
        {...props}
        onOpen={() => document.getElementById("workflow-assignments")?.focus()}
      />
      {selected ? (
        <>
          <div>
            <h3 className="font-medium">{selected.skillName}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {chosenSkill?.enabled
                ? "Installed for this provider"
                : "Unavailable for this provider"}
            </p>
            <p className="mt-1 text-muted-foreground">
              {chosenSkill?.description ??
                "Skill is not available in the current provider catalog."}
            </p>
            <p className="mt-2 break-all text-xs text-muted-foreground">{selected.skillPath}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              The agent reads this skill and its referenced playbook when the turn starts. The skill
              supplies its stages and default cast.
            </p>
          </div>
          <div id="workflow-assignments" tabIndex={-1} className="space-y-3">
            <h3 className="font-medium">Agent assignments</h3>
            <p className="text-xs text-muted-foreground">
              Requested routes for work the agent delegates. Skill default uses your configured
              cast. Selecting a route does not start an agent.
            </p>
            {workflowRoles.map((role) => {
              const current = selected.assignments[role];
              const choices = props.providers.flatMap((provider) =>
                provider.models.map((model) => ({
                  key: JSON.stringify([provider.instanceId, model.slug]),
                  provider,
                  model,
                })),
              );
              const value = current
                ? JSON.stringify([current.providerInstanceId, current.model])
                : "";
              return (
                <label key={role} className="flex flex-col gap-1.5">
                  <span className="capitalize">{role}</span>
                  <select
                    aria-label={`${role} agent`}
                    className="w-full rounded-md border border-border bg-background px-2 py-2 text-foreground"
                    disabled={props.disabled}
                    value={value}
                    onChange={(event) => {
                      const choice = choices.find((entry) => entry.key === event.target.value);
                      const assignments = { ...selected.assignments };
                      if (choice)
                        assignments[role] = {
                          providerInstanceId: choice.provider.instanceId,
                          model: choice.model.slug,
                        };
                      else delete assignments[role];
                      useWorkflowStore
                        .getState()
                        .select(props.threadKey, { ...selected, assignments });
                    }}
                  >
                    <option value="">Skill default</option>
                    {current && !choices.some((choice) => choice.key === value) && (
                      <option value={value}>{current.model} · unavailable</option>
                    )}
                    {choices.map(({ key, provider, model }) => (
                      <option
                        key={key}
                        value={key}
                        disabled={
                          !provider.enabled || !provider.isAvailable || provider.status !== "ready"
                        }
                      >
                        {provider.displayName} / {model.name ?? model.slug}
                        {!provider.enabled || !provider.isAvailable || provider.status !== "ready"
                          ? " · unavailable"
                          : ""}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
            {reason && (
              <p role="status" className="text-destructive">
                {reason}
              </p>
            )}
          </div>
        </>
      ) : (
        <p className="text-muted-foreground">
          {installed.length
            ? "Choose an installed workflow above to configure the next turn."
            : "No workflow skills were reported for this provider and workspace. Install a skill such as poteto-mode or rasmic-mode, then refresh the provider's skills."}
        </p>
      )}
      <div className="space-y-2 border-t border-border pt-4">
        <h3 className="font-medium">Turn history</h3>
        {applied.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No workflow has been sent in the loaded conversation.
          </p>
        ) : (
          applied.toReversed().map(({ message, config }) => (
            <details key={message.id} className="rounded-md border border-border p-3">
              <summary className="cursor-pointer">
                {config.skillName} · {message.runId ? "Applied to turn" : "Sent; awaiting turn"}
              </summary>
              <p className="mt-2 text-xs text-muted-foreground">
                {new Date(message.createdAt).toLocaleString()} · Instructions sent, execution is
                confirmed only by task records and evidence.
              </p>
              <p className="mt-2 break-all text-xs">{config.skillPath}</p>
              {workflowRoles.map((role) => (
                <p key={role} className="mt-1 text-xs">
                  {role}:{" "}
                  {config.assignments[role]
                    ? `${config.assignments[role].providerInstanceId} / ${config.assignments[role].model}`
                    : "Skill default"}
                </p>
              ))}
            </details>
          ))
        )}
      </div>
      <div className="space-y-2 border-t border-border pt-4">
        <h3 className="font-medium">Latest workflow turn</h3>
        {tasks.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No delegated tasks recorded for this turn. No stages or verification checks are marked
            complete without evidence.
          </p>
        ) : (
          tasks.map((task) => (
            <div key={task.id} className="rounded-md border border-border p-3">
              <p>
                {task.title ?? task.model ?? "Agent"} · {task.status}
              </p>
              {task.workflow?.phases.map((phase) => (
                <p key={phase.index} className="mt-1 text-xs">
                  {phase.title}
                </p>
              ))}
              {task.result && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs">Result / reported evidence</summary>
                  <pre className="mt-2 whitespace-pre-wrap break-words text-xs">{task.result}</pre>
                </details>
              )}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
