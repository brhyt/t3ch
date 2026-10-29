import { describe, expect, it } from "vite-plus/test";
import {
  editDesignSource,
  findDesignSources,
  applyDesignPatch,
  canEditDesignText,
} from "./designSource.ts";

const target = {
  tagName: "h1",
  text: "Hello world",
  selector: "h1",
  pageUrl: "http://localhost:3000",
  sourceFile: null,
};

describe("design source edits", () => {
  it("finds static JSX while excluding computed content", () => {
    const source =
      "export const View = () => <><h1>Hello world</h1><h1>{title}</h1><h1>Hello <em>world</em></h1></>";
    expect(findDesignSources(source, target)).toEqual([
      "<h1>Hello world</h1>",
      "<h1>Hello <em>world</em></h1>",
    ]);
    expect(findDesignSources("const x = <h1>{'Hello world'}</h1>", target)).toEqual([
      "<h1>{'Hello world'}</h1>",
    ]);
  });
  it("finds and styles a static layout container without changing its children", () => {
    const source = '<section className="layout"><h2>Tools</h2><p>For your studio</p></section>';
    const container = { ...target, tagName: "section", text: "ToolsFor your studio" };
    expect(findDesignSources(source, container)).toEqual([source]);
    const after = editDesignSource(source, "display", "flex");
    expect(applyDesignPatch(source, source, after, "display")).toBe(
      '<section className="layout" style={{ display: "flex" }}><h2>Tools</h2><p>For your studio</p></section>',
    );
    expect(() => editDesignSource(source, "textContent", "Replacement")).toThrow();
  });
  it("escapes text as a literal expression so markup and braces stay text", () => {
    expect(
      editDesignSource(
        '<h1 className="title">Hello world</h1>',
        "textContent",
        '<script>{"x"}</script>',
      ),
    ).toBe('<h1 className="title">{"<script>{\\"x\\"}</script>"}</h1>');
  });
  it("updates a literal style without reformatting other attributes or styles", () => {
    expect(
      editDesignSource(
        '<h1 style={{ color: "red", padding: 8 }}>Hello world</h1>',
        "color",
        "#112233",
      ),
    ).toBe('<h1 style={{ color: "#112233", padding: 8 }}>Hello world</h1>');
    const linked = editDesignSource(
      '<h1 style={{ padding: "8px", paddingLeft: "4px" }}>Hello world</h1>',
      "padding",
      "24px",
    );
    for (const side of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"])
      expect(linked).toContain(`${side}: "24px"`);
  });
  it("saves inspector spacing and size values and undoes only the edited property", () => {
    const before = '<h1 style={{ color: "red", paddingBottom: "4px" }}>Hello world</h1>';
    const after = editDesignSource(before, "paddingBottom", "12px");
    expect(after).toBe('<h1 style={{ color: "red", paddingBottom: "12px" }}>Hello world</h1>');
    const concurrent = after.replace('color: "red"', 'color: "blue"');
    expect(applyDesignPatch(concurrent, after, before, "paddingBottom")).toBe(
      '<h1 style={{ color: "blue", paddingBottom: "4px" }}>Hello world</h1>',
    );
    expect(editDesignSource("<div>Panel</div>", "maxWidth", "100%")).toBe(
      '<div style={{ maxWidth: "100%" }}>Panel</div>',
    );
    expect(editDesignSource("<div>Panel</div>", "display", "flex")).toBe(
      '<div style={{ display: "flex" }}>Panel</div>',
    );
  });
  it("undoes linked spacing while preserving unrelated styles", () => {
    const before = '<h1 style={{ color: "red", paddingLeft: "4px" }}>Hello world</h1>';
    const after = editDesignSource(before, "padding", "16px");
    const changed = applyDesignPatch(before, before, after, "padding");
    expect(changed).toContain('paddingLeft: "16px"');
    const restored = applyDesignPatch(
      changed.replace('color: "red"', 'color: "blue"'),
      after,
      before,
      "padding",
    );
    expect(restored).toContain('color: "blue"');
    expect(restored).toContain('paddingLeft: "4px"');
    expect(restored).not.toContain("paddingTop");
  });
  it("refuses dynamic text and styles and spread attributes", () => {
    for (const source of ["<h1>{title}</h1>", "<h1>Hello <em>world</em></h1>"])
      expect(() => editDesignSource(source, "textContent", "new")).toThrow();
    for (const source of [
      "<h1 style={theme}>Hi</h1>",
      "<h1 style={{ ...theme }}>Hi</h1>",
      "<h1 {...props}>Hi</h1>",
    ])
      expect(() => editDesignSource(source, "color", "blue")).toThrow();
  });
});

it("maps conditional and repeated content by element reference and preserves expressions through undo", () => {
  const heading = '<h1>{preview ? "Preview" : "Make it a date."}</h1>';
  const initial = `const View = () => <section>${heading}${heading}</section>`;
  const mapped = { ...target, text: "Make it a date.", sourceIndex: 2 };
  expect(findDesignSources(initial, mapped)).toEqual([heading]);
  expect(canEditDesignText(heading)).toBe(false);
  const after = editDesignSource(heading, "fontSize", "42px");
  const updated = applyDesignPatch(initial, heading, after, "fontSize", 2);
  expect(updated).toBe(
    `const View = () => <section>${heading}<h1 style={{ fontSize: "42px" }}>{preview ? "Preview" : "Make it a date."}</h1></section>`,
  );
  expect(applyDesignPatch(updated, after, heading, "fontSize", 2)).toBe(initial);
  expect(() =>
    applyDesignPatch(
      updated.replace('fontSize: "42px"', 'fontSize: "44px"'),
      after,
      heading,
      "fontSize",
      2,
    ),
  ).toThrow();
});

it("refuses mapped undo when another edit moved a different element into its position", () => {
  const before = '<h2 id="one">{title}</h2>';
  const after = editDesignSource(before, "fontSize", "42px");
  const changed =
    '<section><h2 id="two" style={{ fontSize: "42px" }}>{title}</h2>' + after + "</section>";
  expect(() => applyDesignPatch(changed, after, before, "fontSize", 1)).toThrow();
});
