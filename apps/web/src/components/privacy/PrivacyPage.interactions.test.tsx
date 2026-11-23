// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { PrivacyJournal } from "@t3tools/contracts";
import { PrivacyPage } from "./PrivacyPage";

const state = vi.hoisted(() => ({
  catalog: null as unknown,
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
        sources: () => "sources",
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
        data: machine === "sources" ? state.catalog : machine === "local" ? state.data : null,
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
  state.catalog = null;
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
  const legacy = state.data!.events[0]!;
  state.data = {
    ...state.data!,
    events: [
      legacy,
      {
        ...legacy,
        id: 2,
        launchAttribution: {
          evidence: "launch-linked",
          component: "codex-app-server",
          providerInstanceId: "instance-1",
          launchId: "opaque-1",
          initiatingThreadId: "origin-1",
          workflow: "unknown",
        },
        stages: { inspection: "performed", forwarding: "blocked" },
        findings: [
          {
            kind: "credential",
            location: "body",
            count: 1,
            expected: false,
            detectorId: "credential.v1",
            context: "schema",
            destinationExpectation: "unknown",
            valuePresence: "empty",
            valueType: "string",
          },
        ],
      },
    ],
  };
  await using screen = await mount();
  await act(async () => button(screen.container, "Data flows").click());
  expect(screen.container.textContent).toContain("private.test");
  const rows = [...screen.container.querySelectorAll("tbody tr")];
  const linked = rows.find((row) => row.textContent?.includes("opaque-1"))!;
  expect(linked.querySelectorAll("td")[4]?.textContent).toBe("Unknown");
  expect(linked.textContent).toContain("Launch origin thread: origin-1");
  expect(linked.textContent).toContain("Detection context: schema");
  const unlinked = rows.find((row) => !row.textContent?.includes("opaque-1"))!;
  expect(unlinked.textContent).not.toContain("codex-app-server");
  expect(unlinked.textContent).toContain("Launch evidence: unknown");

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
    component: { name: "observer", version: "fixture", identityKind: "source-hash" },
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
  expect(screen.container.textContent).not.toContain("Save outcome");
  expect(screen.container.textContent).not.toContain("Safe task reference");
  expect(state.calls).toEqual([
    { environmentId: "local", input: { action: "stop-experiment", experimentId: "fixture" } },
  ]);
});

it.each([true, false])(
  "keeps outcomes separate and confirms finished experiment deletion (write=%s)",
  async (write) => {
    setup();
    state.write = write;
    state.data = {
      ...state.data!,
      supportedActions: ["experiment-metadata", "experiment-outcome", "delete-experiment"],
      policyStorage: { status: "ready", persistenceError: false },
      experiments: [
        {
          id: "finished",
          host: "inference.example",
          startedAt: 1,
          expiresAt: 301,
          recoveryAt: 2,
          finishedAt: 3,
          phase: "finished",
          baselineStartedAt: 1,
          baselineEndedAt: 1,
          evidenceIncomplete: true,
          outcome: "unknown",
          evidence: "bounded-proxy-observations",
          baseline: { observed: 1, blocked: 0, responses: 1, errors: 0 },
          blocked: { observed: 1, blocked: 1, responses: 0, errors: 0 },
          recovery: { observed: 1, blocked: 0, responses: 1, errors: 0 },
        },
      ],
    };
    state.catalog = sourceCatalog();
    await using screen = await mount();
    await act(async () => button(screen.container, "Experiments").click());
    expect(screen.container.textContent).toContain("Task outcome unknown");
    if (!write) {
      expect(button(screen.container, "Save outcome").disabled).toBe(true);
      expect(button(screen.container, "Delete experiment").disabled).toBe(true);
      expect(state.calls).toEqual([]);
      return;
    }

    const select = [...screen.container.querySelectorAll("select")].find((node) =>
      node.closest("label")?.textContent?.includes("User-reported outcome"),
    )!;
    await act(async () => {
      select.value = "failed";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button(screen.container, "Save outcome").click());
    await act(async () => button(screen.container, "Delete experiment").click());
    await act(async () => button(screen.container, "Cancel").click());
    expect(state.calls).toEqual([
      {
        environmentId: "local",
        input: { action: "experiment-outcome", experimentId: "finished", outcome: "failed" },
      },
    ]);
    await act(async () => button(screen.container, "Delete experiment").click());
    await selectSource(screen.container, "honcho");
    expect(screen.container.textContent).not.toContain("Confirm deletion");
    await selectSource(screen.container, "primary");
    await act(async () => button(screen.container, "Experiments").click());
    expect(screen.container.textContent).not.toContain("Confirm deletion");
    const resetOutcome = [...screen.container.querySelectorAll("select")].find((node) =>
      node.closest("label")?.textContent?.includes("User-reported outcome"),
    )!;
    expect(resetOutcome.value).toBe("unknown");
    const machine = screen.container.querySelector<HTMLSelectElement>(
      'select[aria-label="Machine"]',
    )!;
    await act(async () => {
      machine.value = "remote";
      machine.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(screen.container.textContent).not.toContain("Confirm deletion");
    await act(async () => {
      machine.value = "local";
      machine.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button(screen.container, "Experiments").click());
    expect(screen.container.textContent).not.toContain("Confirm deletion");
    await act(async () => button(screen.container, "Delete experiment").click());
    await act(async () => button(screen.container, "Confirm deletion").click());
    expect(state.calls).toEqual([
      {
        environmentId: "local",
        input: { action: "experiment-outcome", experimentId: "finished", outcome: "failed" },
      },
      { environmentId: "local", input: { action: "delete-experiment", experimentId: "finished" } },
    ]);
  },
);

function sourceCatalog(extraStatus = "available") {
  return {
    configuration: "valid",
    sources: [
      {
        id: "primary",
        identity: "operator-configured-source",
        permissions: { read: true, change: true },
        status: "available",
        fetchedAt: 100,
        freshness: "fresh",
        journal: state.data,
        hops: [],
      },
      {
        id: "honcho",
        identity: "operator-configured-source",
        permissions: { read: true, change: true },
        status: extraStatus,
        fetchedAt: 200,
        freshness: "unknown",
        journal:
          extraStatus === "available" ? { ...state.data!, label: "extra", events: [] } : null,
        hops: [],
      },
    ],
  };
}
async function selectSource(container: HTMLElement, value: string) {
  const select = container.querySelector<HTMLSelectElement>(
    'select[aria-label="Observer source"]',
  )!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
it("isolates source views and prevents extra mutations even with caller and source write grants", async () => {
  setup();
  state.catalog = sourceCatalog();
  await using screen = await mount();
  await act(async () => button(screen.container, "Data flows").click());
  expect(screen.container.textContent).toContain("private.test");
  const search = screen.container.querySelector<HTMLInputElement>(
    'input[aria-label="Search source, destination or fields"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      search,
      "missing.example",
    );
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(search.value).toBe("missing.example");
  await selectSource(screen.container, "honcho");
  expect(screen.container.textContent).toContain("Evidence at a glance");
  expect(screen.container.textContent).not.toContain("private.test");
  await act(async () => button(screen.container, "Data flows").click());
  expect(button(screen.container, "Clear observations").disabled).toBe(true);
  await act(async () => button(screen.container, "Clear observations").click());
  await act(async () => button(screen.container, "Controls").click());
  expect(screen.container.textContent).toContain("Environment controls are unavailable");
  expect(state.calls).toEqual([]);
  await selectSource(screen.container, "primary");
  await act(async () => button(screen.container, "Data flows").click());
  expect(
    screen.container.querySelector<HTMLInputElement>(
      'input[aria-label="Search source, destination or fields"]',
    )?.value,
  ).toBe("");
  expect(screen.container.textContent).toContain("private.test");
  expect(button(screen.container, "Clear observations").disabled).toBe(false);
});
it("keeps primary evidence when an extra is unavailable", async () => {
  setup();
  state.catalog = sourceCatalog("unavailable");
  await using screen = await mount();
  await selectSource(screen.container, "honcho");
  expect(screen.container.textContent).toContain("Selected source unavailable.");
  expect(screen.container.textContent).not.toContain("Connect the observer");
  await selectSource(screen.container, "primary");
  await act(async () => button(screen.container, "Data flows").click());
  expect(screen.container.textContent).toContain("private.test");
});
it.each([null, {}, { configuration: "valid", sources: [] }])(
  "falls back to legacy primary for unavailable or malformed catalogs: %j",
  async (catalog) => {
    setup();
    state.catalog = catalog;
    await using screen = await mount();
    expect(screen.container.textContent).toContain("Extra sources unavailable");
    await act(async () => button(screen.container, "Data flows").click());
    expect(screen.container.textContent).toContain("private.test");
  },
);

it("shows an available extra independently of an unconfigured primary", async () => {
  setup();
  const catalog = sourceCatalog();
  catalog.sources[0]!.status = "not-configured";
  catalog.sources[0]!.journal = null;
  state.catalog = catalog;
  await using screen = await mount();
  expect(screen.container.textContent).toContain("Connect the observer");
  await selectSource(screen.container, "honcho");
  expect(screen.container.textContent).not.toContain("Connect the observer");
  expect(screen.container.textContent).toContain("extra");
});
it("reports invalid extras while retaining primary evidence", async () => {
  setup();
  state.catalog = {
    ...sourceCatalog(),
    configuration: "invalid-extras",
    sources: sourceCatalog().sources.slice(0, 1),
  };
  await using screen = await mount();
  expect(screen.container.textContent).toContain("Extra source configuration is invalid");
  await act(async () => button(screen.container, "Data flows").click());
  expect(screen.container.textContent).toContain("private.test");
});
it("requires diagnostics permission before showing any source evidence", async () => {
  setup();
  state.catalog = sourceCatalog();
  state.read = false;
  await using screen = await mount();
  expect(screen.container.textContent).toContain("Diagnostics permission is required");
  expect(screen.container.querySelector('select[aria-label="Observer source"]')).toBeNull();
  expect(screen.container.textContent).not.toContain("private.test");
});
