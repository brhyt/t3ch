import type { ServerProviderSkillAction } from "@t3tools/contracts";

export function filterSkillActions(
  actions: ReadonlyArray<ServerProviderSkillAction>,
  query: string,
): ServerProviderSkillAction[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...actions];
  return actions
    .map((action, index) => {
      const command = action.command.toLocaleLowerCase();
      const usage = action.usage.toLocaleLowerCase();
      const description = action.description?.toLocaleLowerCase() ?? "";
      const score =
        command === normalized || command.split(":").at(-1) === normalized
          ? 0
          : command.includes(normalized)
            ? 1
            : usage.includes(normalized)
              ? 2
              : description.includes(normalized)
                ? 3
                : null;
      return { action, index, score };
    })
    .filter((entry) => entry.score !== null)
    .sort((left, right) => (left.score ?? 0) - (right.score ?? 0) || left.index - right.index)
    .map((entry) => entry.action);
}

export function skillActionInsertion(skillName: string, command?: string): string {
  return command === undefined ? `$${skillName} ` : `$${skillName} ${command} `;
}
