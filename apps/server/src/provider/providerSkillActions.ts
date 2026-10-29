import type { ServerProviderSkillAction } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { parse as parseYamlDocument } from "yaml";

export const MAX_PROVIDER_SKILL_ACTIONS = 64;
export const MAX_PROVIDER_SKILL_ACTION_BYTES = 512 * 1024;

const ActionMetadata = Schema.Struct({
  command: Schema.String,
  usage: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
});

const ActionMetadataList = Schema.Array(ActionMetadata);
const decodeActionMetadata = Schema.decodeUnknownOption(ActionMetadataList);
const FrontmatterActions = Schema.Struct({ actions: Schema.optional(ActionMetadataList) });
const FrontmatterMetadataActions = Schema.Struct({
  metadata: Schema.optional(Schema.Struct({ actions: ActionMetadataList })),
});
const decodeFrontmatterActions = Schema.decodeUnknownOption(FrontmatterActions);
const decodeFrontmatterMetadataActions = Schema.decodeUnknownOption(FrontmatterMetadataActions);

function cleanCell(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("`") && trimmed.endsWith("`") && trimmed.length >= 2
    ? trimmed.slice(1, -1).trim()
    : trimmed;
}

function actionFromValues(input: {
  readonly command: string;
  readonly usage?: string | undefined;
  readonly description?: string | undefined;
}): ServerProviderSkillAction | null {
  const command = cleanCell(input.command).trim();
  const usage = cleanCell(input.usage ?? command).trim();
  const description = input.description?.trim();
  if (!command || /[\r\n]/.test(command) || !usage) return null;
  return {
    command,
    usage,
    ...(description ? { description } : {}),
  };
}

function splitMarkdownTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  for (const character of trimmed.slice(1, -1)) {
    if (escaped) {
      cell += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
      cell += character;
    } else if (character === "|") {
      cells.push(cell.replaceAll("\\|", "|").trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.replaceAll("\\|", "|").trim());
  return cells;
}

function isSeparatorRow(cells: ReadonlyArray<string>): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.trim()));
}

function actionsFromMarkdownTables(markdown: string): ServerProviderSkillAction[] {
  const lines = markdown.split(/\r?\n/);
  const actions: ServerProviderSkillAction[] = [];
  for (let index = 0; index < lines.length - 2; index++) {
    const header = splitMarkdownTableRow(lines[index] ?? "");
    const separator = splitMarkdownTableRow(lines[index + 1] ?? "");
    if (!header || !separator || !isSeparatorRow(separator)) continue;
    const normalized = header.map((cell) => cleanCell(cell).toLowerCase());
    const commandIndex = normalized.indexOf("command");
    const descriptionIndex = normalized.findIndex(
      (cell) => cell === "job" || cell === "description",
    );
    if (commandIndex < 0 || descriptionIndex < 0) continue;

    for (index += 2; index < lines.length; index++) {
      const cells = splitMarkdownTableRow(lines[index] ?? "");
      if (!cells || isSeparatorRow(cells)) break;
      const usage = cleanCell(cells[commandIndex] ?? "");
      const argumentStart = usage.search(/[<[\]]/);
      const command = (argumentStart < 0 ? usage : usage.slice(0, argumentStart)).trim();
      const action = actionFromValues({
        command,
        usage,
        description: cleanCell(cells[descriptionIndex] ?? ""),
      });
      if (action) actions.push(action);
    }
  }
  return actions;
}

function frontmatterDocument(markdown: string): unknown {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/.exec(markdown);
  if (!match) return undefined;
  try {
    return parseYamlDocument(match[1] ?? "");
  } catch {
    return undefined;
  }
}

function actionsFromFrontmatter(markdown: string): ServerProviderSkillAction[] {
  const document = frontmatterDocument(markdown);
  const topLevel = decodeFrontmatterActions(document);
  const nested = decodeFrontmatterMetadataActions(document);
  const raw = Option.flatMap(topLevel, (value) => Option.fromNullishOr(value.actions)).pipe(
    Option.orElse(() =>
      Option.flatMap(nested, (value) => Option.fromNullishOr(value.metadata?.actions)),
    ),
  );
  return Option.getOrElse(raw, () => []).flatMap((candidate) => {
    const decoded = decodeActionMetadata([candidate]);
    if (Option.isNone(decoded)) return [];
    const action = actionFromValues(decoded.value[0] ?? candidate);
    return action ? [action] : [];
  });
}

export function parseProviderSkillActions(markdown: string): ServerProviderSkillAction[] {
  const frontmatter = actionsFromFrontmatter(markdown);
  const candidates = frontmatter.length > 0 ? frontmatter : actionsFromMarkdownTables(markdown);
  const seen = new Set<string>();
  return candidates
    .filter((action) => {
      if (seen.has(action.command)) return false;
      seen.add(action.command);
      return true;
    })
    .slice(0, MAX_PROVIDER_SKILL_ACTIONS);
}
