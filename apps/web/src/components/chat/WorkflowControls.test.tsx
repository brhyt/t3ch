// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { WorkflowSelector } from "./WorkflowControls";
import { useWorkflowStore } from "~/workflowStore";
import { appendWorkflowContext, readWorkflowContext } from "~/workflowConfig";

vi.mock("~/state/entities", () => ({ useThreadProjection: () => null }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
  useWorkflowStore.setState({ byThread: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("selects a next-turn workflow, switches it without changing the sent snapshot, and turns it off", async () => {
  await act(() =>
    root.render(
      <WorkflowSelector
        threadKey="test-thread"
        skills={[
          { name: "poteto-mode", path: "/poteto/SKILL.md", enabled: true },
          { name: "rasmic-mode", path: "/rasmic/SKILL.md", enabled: true },
        ]}
        providers={[]}
        onOpen={() => {}}
      />,
    ),
  );
  async function choose(label: string) {
    const trigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="Workflow for next turn"]',
    )!;
    await act(() => trigger.click());
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) =>
      entry.textContent?.includes(label),
    );
    expect(option).toBeDefined();
    await act(() => option!.click());
  }
  await choose("poteto-mode");
  expect(container.querySelector('[aria-label="Workflow for next turn"]')?.textContent).toContain(
    "poteto-mode",
  );
  const sent = appendWorkflowContext(
    "Build the UI",
    useWorkflowStore.getState().byThread["test-thread"] ?? null,
  );
  await choose("rasmic-mode");
  expect(useWorkflowStore.getState().byThread["test-thread"]?.skillName).toBe("rasmic-mode");
  expect(readWorkflowContext(sent)?.skillName).toBe("poteto-mode");
  expect(container.textContent).not.toContain("agents running");
  await choose("No workflow");
  expect(useWorkflowStore.getState().byThread["test-thread"]).toBeUndefined();
  expect(container.textContent).not.toContain("No workflow selected");
});
