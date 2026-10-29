// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { DesignPageRequest } from "@t3tools/contracts";
import { DESIGN_OVERLAY_SCRIPT } from "@t3tools/shared/browserDesignOverlay";

const Callable = Schema.declare(
  (value): value is (...args: readonly unknown[]) => unknown => typeof value === "function",
);
const decodeApi = Schema.decodeUnknownSync(
  Schema.Struct({
    poll: Callable,
    ack: Callable,
    flush: Callable,
    stop: Callable,
    present: Callable,
    showMode: Callable,
    refresh: Callable,
  }),
);
const decodeRequest = Schema.decodeUnknownSync(DesignPageRequest);

describe("Design overlay", () => {
  afterEach(() => {
    const value = Reflect.get(window, "__t3Design");
    if (value) {
      const api = decodeApi(value);
      const pending = api.poll();
      if (pending) api.ack({ id: decodeRequest(pending).id, error: "Test finished" });
      api.stop();
    }
    document.documentElement.innerHTML = "<head></head><body></body>";
    Reflect.deleteProperty(window, "__t3Design");
    vi.unstubAllGlobals();
  });
  it.each([false, true])(
    "reconnects after history without replacing the inspector (early HMR: %s)",
    (early) => {
      const mapping = (revision: string) =>
        JSON.stringify({ file: "/project/View.tsx", index: 3, revision });
      const heading = document.createElement("h1");
      heading.textContent = "Heading";
      heading.style.fontSize = "42px";
      heading.setAttribute("data-t3ch-source", mapping("before"));
      document.body.append(heading);
      window.eval(DESIGN_OVERLAY_SCRIPT);
      const api = decodeApi(Reflect.get(window, "__t3Design"));
      const host = document.querySelector("[data-t3-design-ui]");
      heading.click();
      const selected = decodeRequest(api.poll());
      api.ack({
        id: selected.id,
        selection: { id: selected.id, relativePath: "View.tsx" },
        error: null,
      });
      api.present({ canUndo: true, canRedo: false, notes: [] });
      const update = () => {
        const replacement = heading.cloneNode(true);
        if (!(replacement instanceof HTMLElement)) throw new Error("Missing replacement");
        replacement.style.fontSize = "28px";
        replacement.setAttribute("data-t3ch-source", mapping("restored"));
        heading.replaceWith(replacement);
      };
      if (early) update();
      api.refresh({ sourceFile: "/project/View.tsx", sourceRevision: "restored" });
      if (!early) {
        expect(api.poll()).toBeNull();
        update();
      }
      const reselected = decodeRequest(api.poll());
      expect(reselected).toMatchObject({
        _tag: "select",
        target: { sourceRevision: "restored", sourceIndex: 3 },
      });
      api.ack({
        id: reselected.id,
        selection: { id: reselected.id, relativePath: "View.tsx" },
        error: null,
      });
      expect(document.querySelector("[data-t3-design-ui]")).toBe(host);
      const field = host?.shadowRoot?.querySelector('[data-property="fontSize"]');
      if (!(field instanceof HTMLInputElement)) throw new Error("Missing field");
      expect(field.value).toBe("28");
      expect(field.disabled).toBe(false);
    },
  );
  it("keeps computed styles visible after source lookup fails and updates on another selection", () => {
    document.body.innerHTML =
      '<h2 style="font-size:32px">First</h2><p style="font-size:18px">Second</p>';
    window.eval(DESIGN_OVERLAY_SCRIPT);
    const api = decodeApi(Reflect.get(window, "__t3Design"));
    const root = document.querySelector("[data-t3-design-ui]")?.shadowRoot;
    for (const [selector, size] of [
      ["h2", "32"],
      ["p", "18"],
    ]) {
      const element = document.querySelector(selector ?? "");
      if (!(element instanceof HTMLElement)) throw new Error("Missing fixture element");
      element.click();
      const request = decodeRequest(api.poll());
      const field = root?.querySelector('[data-property="fontSize"]');
      expect(field).toBeInstanceOf(HTMLInputElement);
      if (!(field instanceof HTMLInputElement)) throw new Error("Missing font size");
      expect(field.value).toBe(size);
      api.ack({ id: request.id, error: "Cannot map source" });
      expect(root?.querySelector(".fields")?.getAttribute("style")).toContain("display: block");
      expect(field.value).toBe(size);
      expect(field.disabled).toBe(true);
      api.showMode("annotate");
      api.showMode("style");
      expect(root?.querySelector(".fields")?.getAttribute("style")).toContain("display: block");
    }
  });
  it("keeps mapped dynamic text read-only while enabling style edits", () => {
    vi.stubGlobal("CSS", { supports: () => true });
    const heading = document.createElement("h1");
    heading.textContent = "Make it a date.";
    heading.setAttribute(
      "data-t3ch-source",
      JSON.stringify({ file: "/project/View.tsx", index: 3, revision: "revision" }),
    );
    document.body.append(heading);
    window.eval(DESIGN_OVERLAY_SCRIPT);
    heading.click();
    const api = decodeApi(Reflect.get(window, "__t3Design"));
    const request = decodeRequest(api.poll());
    expect(request).toMatchObject({
      target: { sourceFile: "/project/View.tsx", sourceIndex: 3, sourceRevision: "revision" },
    });
    api.ack({
      id: request.id,
      selection: { id: request.id, relativePath: "View.tsx", canEditText: false },
      error: null,
    });
    heading.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(heading.getAttribute("contenteditable")).toBeNull();
    const root = document.querySelector("[data-t3-design-ui]")?.shadowRoot;
    const field = root?.querySelector('[data-property="fontSize"]');
    if (!(field instanceof HTMLInputElement)) throw new Error("Missing font size field");
    expect(field.disabled).toBe(false);
    field.value = "42";
    field.dispatchEvent(new Event("change"));
    expect(decodeRequest(api.poll())).toMatchObject({
      _tag: "edit",
      property: "fontSize",
      value: "42px",
    });
  });
  it("opens annotation controls directly and switches back to styling", () => {
    window.eval(DESIGN_OVERLAY_SCRIPT);
    const api = decodeApi(Reflect.get(window, "__t3Design"));
    const root = document.querySelector("[data-t3-design-ui]")?.shadowRoot;
    api.showMode("annotate");
    expect(root?.querySelector(".notearea")?.hasAttribute("hidden")).toBe(false);
    expect(root?.activeElement?.getAttribute("aria-label")).toBe("Note for agent");
    api.showMode("style");
    expect(root?.querySelector(".notearea")?.hasAttribute("hidden")).toBe(true);
  });
  it("requests saved notes after injection and restores their pins", () => {
    const heading = document.createElement("h1");
    heading.textContent = "Title";
    document.body.append(heading);
    window.eval(DESIGN_OVERLAY_SCRIPT);
    const api = decodeApi(Reflect.get(window, "__t3Design"));
    expect(decodeRequest(api.poll())._tag).toBe("ready");
    api.present({
      canUndo: false,
      canRedo: false,
      notes: [
        {
          id: "note",
          pageUrl: location.href,
          comment: "Review title",
          target: { selector: "h1", tagName: "h1", text: "Title", relativePath: "View.tsx" },
        },
      ],
    });
    expect(api.poll()).toBeNull();
    expect(document.querySelector('[aria-label="Annotation 1"]')?.textContent).toBe("1");
    const root = document.querySelector("[data-t3-design-ui]")?.shadowRoot;
    expect(root?.querySelector(".note-list")?.textContent).toContain("Review title");
    api.stop();
    expect(document.querySelector('[aria-label="Annotation 1"]')).toBeNull();
  });
  it("lets users choose a font weight in the streamed page without a native popup", () => {
    vi.stubGlobal("CSS", { supports: () => true });
    const heading = document.createElement("h1");
    heading.textContent = "Heading";
    document.body.append(heading);
    window.eval(DESIGN_OVERLAY_SCRIPT);
    heading.click();
    const api = decodeApi(Reflect.get(window, "__t3Design"));
    const request = decodeRequest(api.poll());
    api.ack({
      id: request.id,
      selection: { id: request.id, relativePath: "View.tsx" },
      error: null,
    });
    const root = document.querySelector("[data-t3-design-ui]")?.shadowRoot;
    const weight = root?.querySelector('[aria-label="Weight"]');
    expect(weight).toBeInstanceOf(HTMLButtonElement);
    if (!(weight instanceof HTMLButtonElement)) return;
    weight.click();
    const option = root?.querySelector('[role="option"][data-value="400"]');
    expect(option).toBeInstanceOf(HTMLButtonElement);
    if (!(option instanceof HTMLButtonElement)) return;
    option.click();
    expect(decodeRequest(api.poll())).toMatchObject({
      _tag: "edit",
      property: "fontWeight",
      value: "400",
    });
  });
  it("treats a bare font size as pixels and keeps annotation reachable", () => {
    vi.stubGlobal("CSS", { supports: () => true });
    const heading = document.createElement("h1");
    heading.textContent = "Heading";
    document.body.append(heading);
    window.eval(DESIGN_OVERLAY_SCRIPT);
    heading.click();
    const api = decodeApi(Reflect.get(window, "__t3Design"));
    const request = decodeRequest(api.poll());
    api.ack({
      id: request.id,
      selection: { id: request.id, relativePath: "View.tsx" },
      error: null,
    });
    const root = document.querySelector("[data-t3-design-ui]")?.shadowRoot;
    const size = root?.querySelector('[aria-label="Size"]');
    if (!(size instanceof HTMLInputElement)) throw new Error("Missing size control");
    size.value = "24";
    size.dispatchEvent(new Event("change"));
    expect(decodeRequest(api.poll())).toMatchObject({
      _tag: "edit",
      property: "fontSize",
      value: "24px",
    });
    expect(root?.querySelector("header button.annotate")?.textContent).toBe("Annotate");
  });
  it("attaches feedback for a selected element even when its source cannot be mapped", () => {
    const container = document.createElement("section");
    container.textContent = "Dynamic content";
    document.body.append(container);
    window.eval(DESIGN_OVERLAY_SCRIPT);
    container.click();
    const api = decodeApi(Reflect.get(window, "__t3Design"));
    const request = decodeRequest(api.poll());
    api.ack({ id: request.id, selection: null, error: "Source cannot be mapped" });
    const root = document.querySelector("[data-t3-design-ui]")?.shadowRoot;
    const annotate = root?.querySelector("button.annotate");
    if (!(annotate instanceof HTMLButtonElement)) throw new Error("Missing Annotate button");
    annotate.click();
    const note = root?.querySelector("textarea");
    const attach = root?.querySelector("button.note");
    if (!(note instanceof HTMLTextAreaElement) || !(attach instanceof HTMLButtonElement))
      throw new Error("Missing annotation controls");
    expect(note.closest(".notearea")?.hasAttribute("hidden")).toBe(false);
    note.value = "Align this with the heading";
    attach.click();
    expect(decodeRequest(api.poll())).toMatchObject({
      _tag: "note",
      comment:
        "Align this with the heading\nTarget: source not mapped · body > section · Dynamic content",
    });
  });
  it("selects a parent through breadcrumbs and restores docking on exit", () => {
    const container = document.createElement("article");
    container.innerHTML = "<h2>Card title</h2>";
    document.body.append(container);
    window.eval(DESIGN_OVERLAY_SCRIPT);
    container.querySelector("h2")?.click();
    const api = decodeApi(Reflect.get(window, "__t3Design"));
    const initial = decodeRequest(api.poll());
    api.ack({ id: initial.id, selection: { id: initial.id, relativePath: "Card.tsx" } });
    const root = document.querySelector("[data-t3-design-ui]")?.shadowRoot;
    const parent = root?.querySelector('[aria-label="Select article"]');
    if (!(parent instanceof HTMLButtonElement)) throw new Error("Missing parent breadcrumb");
    parent.click();
    expect(decodeRequest(api.poll())).toMatchObject({
      _tag: "select",
      target: { tagName: "article", text: "Card title" },
    });
    expect(document.documentElement.style.getPropertyValue("--t3-designer-width")).toBe("340px");
    const request = decodeRequest(api.poll());
    api.ack({ id: request.id, error: "Done" });
    api.stop();
    expect(document.documentElement.style.getPropertyValue("--t3-designer-width")).toBe("");
  });
  it("links spacing sides in one saved shorthand edit and hides typography for containers", () => {
    vi.stubGlobal("CSS", { supports: () => true });
    const container = document.createElement("article");
    container.innerHTML = "<h2>Card title</h2>";
    document.body.append(container);
    window.eval(DESIGN_OVERLAY_SCRIPT);
    container.click();
    const api = decodeApi(Reflect.get(window, "__t3Design"));
    const request = decodeRequest(api.poll());
    api.ack({ id: request.id, selection: { id: request.id, relativePath: "Card.tsx" } });
    const root = document.querySelector("[data-t3-design-ui]")?.shadowRoot;
    expect(root?.querySelector('[data-group="Typography"]')?.hasAttribute("hidden")).toBe(true);
    const link = root?.querySelector('[aria-label="Link padding sides"]');
    const input = root?.querySelector('[aria-label="padding top"]');
    if (!(link instanceof HTMLInputElement) || !(input instanceof HTMLInputElement))
      throw new Error("Missing spacing controls");
    link.click();
    input.value = "16";
    input.dispatchEvent(new Event("change"));
    expect(decodeRequest(api.poll())).toMatchObject({
      _tag: "edit",
      property: "padding",
      value: "16px",
    });
    expect(container.style.padding).toBe("16px");
  });
  it("changes dimension units and sends the selected unit to source", () => {
    vi.stubGlobal("CSS", { supports: () => true });
    const heading = document.createElement("h1");
    heading.textContent = "Title";
    heading.style.fontSize = "2px";
    document.body.append(heading);
    window.eval(DESIGN_OVERLAY_SCRIPT);
    heading.click();
    const api = decodeApi(Reflect.get(window, "__t3Design"));
    const request = decodeRequest(api.poll());
    api.ack({ id: request.id, selection: { id: request.id, relativePath: "Card.tsx" } });
    const root = document.querySelector("[data-t3-design-ui]")?.shadowRoot;
    const unit = root?.querySelector('[aria-label="Size unit"]');
    if (!(unit instanceof HTMLButtonElement)) throw new Error("Missing unit control");
    unit.click();
    const rem = Array.from(root?.querySelectorAll('[aria-label="Size units"] button') ?? []).find(
      (button) => button.textContent === "rem",
    );
    if (!(rem instanceof HTMLButtonElement)) throw new Error("Missing rem option");
    rem.click();
    expect(decodeRequest(api.poll())).toMatchObject({
      _tag: "edit",
      property: "fontSize",
      value: "2rem",
    });
  });
  it("lets a selected element enter inline text editing on double-click and groups the text change", () => {
    const heading = document.createElement("h1");
    heading.textContent = "Original";
    document.body.append(heading);
    // The standalone bundle is the actual script injected into Chromium.
    window.eval(DESIGN_OVERLAY_SCRIPT);
    heading.click();
    const api = decodeApi(Reflect.get(window, "__t3Design"));
    const request = decodeRequest(api.poll());
    expect(request._tag).toBe("select");
    api.ack({
      id: request.id,
      selection: { id: request.id, relativePath: "View.tsx" },
      error: null,
    });
    heading.click();
    heading.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(heading.getAttribute("contenteditable")).toBe("plaintext-only");
    heading.textContent = "Updated";
    heading.dispatchEvent(new Event("input", { bubbles: true }));
    const edit = decodeRequest(api.flush());
    expect(edit).toMatchObject({
      _tag: "edit",
      property: "textContent",
      previousValue: "Original",
      value: "Updated",
      selectionId: request.id,
    });
    expect(decodeRequest(api.poll()).id).toBe(edit.id);
  });
});
