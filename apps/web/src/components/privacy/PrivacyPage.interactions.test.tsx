// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { PrivacyJournal } from "@t3tools/contracts";
import { PrivacyPage } from "./PrivacyPage";

const state = vi.hoisted(() => ({
  read: true,
  write: true,
  calls: [] as unknown[],
  data: null as PrivacyJournal | null,
}));
vi.mock(import("./PrivacyControlsPanel"), () => ({ PrivacyControlsPanel: () => <></> }));
vi.mock(import("@effect/atom-react"), () => ({ useAtomValue: () => state.write }));
vi.mock(
  import("../ui/sidebar"),
  () =>
    ({
      SidebarInset: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      SidebarTrigger: () => null,
    }) as never,
);
vi.mock(
  import("../WorkspacePageHeader"),
  () =>
    ({
      WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
    }) as never,
);
vi.mock(
  import("../sidebar/mainAppLocation"),
  () => ({ useNavigateToMainApp: () => () => Promise.resolve() }) as never,
);
vi.mock(
  import("../../hooks/useNavigateBack"),
  () => ({ useEscapeToGoBack: () => undefined }) as never,
);
vi.mock(
  import("../../state/environments"),
  () =>
    ({
      usePrimaryEnvironmentId: () => "local",
      useEnvironments: () => ({
        environments: [
          { environmentId: "local", label: "Local" },
          { environmentId: "remote", label: "Remote" },
        ],
      }),
    }) as never,
);
vi.mock(import("../../state/session"), () => ({ useEnvironmentScope: () => state.read }) as never);
vi.mock(
  import("../../state/privacy"),
  () =>
    ({
      privacy: {
        snapshot: ({ environmentId }: { environmentId: string }) => environmentId,
        change: { permissionAtom: () => state.write },
      },
    }) as never,
);
vi.mock(
  import("../../state/query"),
  () =>
    ({
      useEnvironmentQuery: (machine: string | null) => ({
        isSuccess: machine !== null,
        isPending: false,
        data: machine === "local" ? state.data : null,
        refresh: () => undefined,
      }),
    }) as never,
);
vi.mock(
  import("../../state/use-atom-command"),
  () =>
    ({
      useAtomCommand: () => async (input: unknown) => {
        state.calls.push(input);
        return { _tag: "Success" };
      },
    }) as never,
);

async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<PrivacyPage />));
  return {
    container,
    async [Symbol.asyncDispose]() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}
function button(container: HTMLElement, text: string) {
  const match = [...container.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === text,
  );
  if (!match) throw new Error(`Missing button ${text}`);
  return match;
}
function setup() {
  state.read = true;
  state.write = true;
  state.calls = [];
  state.data = {
    label: "operator",
    coverage: "routed only",
    observed: 1,
    blocked: [],
    events: [
      {
        id: 1,
        time: 1,
        host: "private.test",
        source: "operator",
        method: "POST",
        status: "blocked",
        category: "unknown",
        bodyBytes: 100,
        fields: [],
        inspection: "unknown",
        scanTruncated: false,
        findings: [],
      },
    ],
  };
}
it("resets the active view on machine changes and guards scoped mutations", async () => {
  setup();
  state.write = false;
  await using screen = await mount();
  await act(async () => button(screen.container, "Data flows").click());
  expect(screen.container.textContent).toContain("private.test");
  expect(button(screen.container, "Clear observations").disabled).toBe(true);
  expect(button(screen.container, "Block").disabled).toBe(true);
  const select = screen.container.querySelector<HTMLSelectElement>('select[aria-label="Machine"]')!;
  await act(async () => {
    select.value = "remote";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(screen.container.textContent).not.toContain("private.test");
  expect(button(screen.container, "Overview").getAttribute("aria-pressed")).toBe("true");
  expect(state.calls).toEqual([]);
});
it("does not reveal observations without diagnostics scope", async () => {
  setup();
  state.read = false;
  await using screen = await mount();
  expect(screen.container.textContent).toContain("Diagnostics permission is required");
  expect(screen.container.textContent).not.toContain("private.test");
});

it("uses the selected machine for experiment recovery and retains unknown task outcomes", async () => {
  setup();
  state.data = {
    ...state.data!,
    policyStorage: { status: "ready", persistenceError: false },
    experiments: [
      {
        id: "fixture",
        host: "private.test",
        startedAt: 1,
        expiresAt: 301,
        recoveryAt: null,
        finishedAt: null,
        phase: "blocked",
        baselineStartedAt: 1,
        baselineEndedAt: 1,
        evidenceIncomplete: true,
        outcome: "unknown",
        evidence: "bounded-proxy-observations",
        baseline: { observed: 1, blocked: 0, responses: 1, errors: 0 },
        blocked: { observed: 1, blocked: 1, responses: 0, errors: 0 },
        recovery: { observed: 0, blocked: 0, responses: 0, errors: 0 },
      },
    ],
  };
  await using screen = await mount();
  await act(async () => button(screen.container, "Experiments").click());
  expect(screen.container.textContent).toContain("Evidence is incomplete");
  await act(async () => button(screen.container, "Restore access and collect recovery").click());
  expect(screen.container.textContent).toContain("Task outcome unknown");
  expect(state.calls).toEqual([
    { environmentId: "local", input: { action: "stop-experiment", experimentId: "fixture" } },
  ]);
});
