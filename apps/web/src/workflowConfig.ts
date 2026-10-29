import * as Schema from "effect/Schema";
import type { ServerProviderSkill } from "@t3tools/contracts";
import type { ProviderInstanceEntry } from "./providerInstances";

export const workflowRoles = ["investigate", "implement", "review", "verify"] as const;
export type WorkflowRole = (typeof workflowRoles)[number];
const Assignment = Schema.Struct({ providerInstanceId: Schema.String, model: Schema.String });
export const WorkflowConfig = Schema.Struct({
  skillName: Schema.String,
  skillPath: Schema.String,
  assignments: Schema.Record(Schema.String, Assignment),
});
export type WorkflowConfig = typeof WorkflowConfig.Type;
const decodeConfig = Schema.decodeUnknownOption(WorkflowConfig);
const marker = "\n\n<t3-workflow-v1>\n";
const endMarker = "\n</t3-workflow-v1>";
const workflowInstructions =
  "\nUse the workflow skill named above for this turn. Read its SKILL.md at the recorded path and its referenced instructions before working. Resolve default agent roles from the skill and the configured cast. Explicit role assignments override those defaults. Delegate only the work this task needs, using the live tool catalog. Report unavailable routes instead of silently substituting. Preserve existing work and obey the user's scope and permissions. Record verification evidence and actual delegated tasks; do not claim that planned steps ran.";

export function workflowSkills(skills: readonly ServerProviderSkill[]) {
  return skills.filter((skill) => skill.name.endsWith("-mode"));
}

export function workflowBlockReason(
  config: WorkflowConfig | null,
  skills: readonly ServerProviderSkill[],
  providers: readonly ProviderInstanceEntry[],
): string | null {
  if (!config) return null;
  const skill = skills.find(
    (entry) => entry.name === config.skillName && entry.path === config.skillPath,
  );
  if (!skill?.enabled || skill.userInvocable === false)
    return `Workflow skill ${config.skillName} is unavailable for this provider and workspace.`;
  if (skill.userInvocationOnly)
    return `Use /${skill.name} to invoke this skill; it requires a native slash command.`;
  for (const [role, assignment] of Object.entries(config.assignments)) {
    const provider = providers.find((entry) => entry.instanceId === assignment.providerInstanceId);
    if (
      !provider?.enabled ||
      !provider.isAvailable ||
      provider.status !== "ready" ||
      !provider.models.some((model) => model.slug === assignment.model)
    ) {
      return `The ${role} assignment is unavailable. Choose another model or use the skill default.`;
    }
  }
  return null;
}

export function appendWorkflowContext(text: string, config: WorkflowConfig | null): string {
  if (!config || text.trimStart().startsWith("/")) return text;
  return `${text}${marker}${JSON.stringify(config)}${endMarker}${workflowInstructions}`;
}

export function readWorkflowContext(text: string): WorkflowConfig | null {
  const start = text.lastIndexOf(marker);
  if (start < 0) return null;
  const end = text.indexOf(endMarker, start + marker.length);
  if (end < 0) return null;
  try {
    const decoded = decodeConfig(JSON.parse(text.slice(start + marker.length, end)));
    return decoded._tag === "Some" ? decoded.value : null;
  } catch {
    return null;
  }
}

export function workflowDisplayText(text: string): string {
  if (!readWorkflowContext(text)) return text;
  const start = text.lastIndexOf(marker);
  const end = text.indexOf(endMarker, start + marker.length) + endMarker.length;
  const remainder = text.slice(end);
  return (
    text.slice(0, start) +
    (remainder.startsWith(workflowInstructions)
      ? remainder.slice(workflowInstructions.length)
      : remainder)
  );
}
