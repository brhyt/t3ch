import type { ServerProviderSkill, ServerProviderSkillAction } from "@t3tools/contracts";
import { BlocksIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import { Command, CommandInput, CommandItem, CommandList } from "../ui/command";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { filterSkillActions } from "./skillActionPicker";

export function SkillActionsDialog(props: {
  readonly open: boolean;
  readonly skill: ServerProviderSkill;
  readonly actions: ReadonlyArray<ServerProviderSkillAction>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (action: ServerProviderSkillAction | null) => void;
}) {
  const [query, setQuery] = useState("");
  const visibleActions = useMemo(
    () => filterSkillActions(props.actions, query),
    [props.actions, query],
  );
  const skillLabel = formatProviderSkillDisplayName(props.skill);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{skillLabel}</DialogTitle>
          <DialogDescription>Choose an action, or insert the skill by itself.</DialogDescription>
        </DialogHeader>
        <Command
          mode="none"
          value={query}
          onValueChange={setQuery}
          aria-label="Choose skill action"
        >
          <CommandInput placeholder="Search actions..." />
          <div className="max-h-80 overflow-y-auto px-2 pb-2">
            <CommandList>
              {!query.trim() ? (
                <CommandItem
                  value={`base:${props.skill.name}`}
                  onClick={() => props.onSelect(null)}
                >
                  <BlocksIcon aria-hidden className="size-4 shrink-0" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span>Use {skillLabel}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      Insert the skill without choosing an action
                    </span>
                  </span>
                </CommandItem>
              ) : null}
              {visibleActions.map((action) => (
                <CommandItem
                  key={action.command}
                  value={action.command}
                  onClick={() => props.onSelect(action)}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-medium">{action.command}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {action.description ?? action.usage}
                    </span>
                  </span>
                  {action.usage !== action.command ? (
                    <span className="text-xs text-muted-foreground">{action.usage}</span>
                  ) : null}
                </CommandItem>
              ))}
              {visibleActions.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No matching actions.
                </div>
              ) : null}
            </CommandList>
          </div>
        </Command>
      </DialogPopup>
    </Dialog>
  );
}
