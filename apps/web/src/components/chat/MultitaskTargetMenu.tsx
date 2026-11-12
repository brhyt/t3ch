import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { ChevronDownIcon } from "lucide-react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useLinkedEnvironments } from "../../state/peerLinks";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu";
import { ComposerControl } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";

const HERE = "here";

/** The linked environment a thread's next Multitask runs on; null runs it on the thread's own machine. */
const multitaskMachineAtom = Atom.family((_threadKey: string) =>
  Atom.make<EnvironmentId | null>(null).pipe(Atom.keepAlive),
);

const threadKey = (environmentId: EnvironmentId, threadId: ThreadId) =>
  `${environmentId}:${threadId}`;

/** Read at send time, so the choice never has to travel through the submit path. */
export function readMultitaskMachine(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): EnvironmentId | null {
  return appAtomRegistry.get(multitaskMachineAtom(threadKey(environmentId, threadId)));
}

/**
 * Picks the machine a Multitask runs on, beside the Multitask button. The model comes from the
 * composer's model picker; only the machine is chosen here, and only while links exist.
 */
export function MultitaskTargetMenu(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly disabled?: boolean;
}) {
  const linked = useLinkedEnvironments(props.environmentId);
  const atom = multitaskMachineAtom(threadKey(props.environmentId, props.threadId));
  const stored = useAtomValue(atom);
  const menuProps = useComposerMenuProps();
  // A machine unlinked since it was picked falls back to this one.
  const selected = stored !== null && linked.has(stored) ? stored : null;
  if (linked.size === 0) return null;
  const selectedLabel = selected === null ? null : (linked.get(selected) ?? null);
  return (
    <Menu>
      <MenuTrigger
        render={<ComposerControl size="xs" />}
        disabled={props.disabled}
        aria-label={`Multitask runs on ${selectedLabel ?? "this machine"}`}
      >
        {selectedLabel === null ? null : <span data-composer-control-label>{selectedLabel}</span>}
        <ChevronDownIcon data-composer-control-chevron aria-hidden="true" />
      </MenuTrigger>
      <MenuPopup align="end" side="top" {...menuProps}>
        <MenuGroup>
          <MenuGroupLabel>Multitask runs on</MenuGroupLabel>
          <MenuRadioGroup
            value={selected ?? HERE}
            onValueChange={(value) =>
              appAtomRegistry.set(atom, value === HERE ? null : (value as EnvironmentId))
            }
          >
            <MenuRadioItem value={HERE} closeOnClick>
              This machine, in a new worktree
            </MenuRadioItem>
            {[...linked].map(([environmentId, label]) => (
              <MenuRadioItem key={environmentId} value={environmentId} closeOnClick>
                {label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
