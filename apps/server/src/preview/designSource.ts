import { parse } from "@babel/parser";
import * as t from "@babel/types";
import { BrowserDesignError, type DesignProperty, type DesignTarget } from "@t3tools/contracts";

const normalizeText = (text: string) => text.replace(/\s+/g, " ").trim();

function elements(source: string) {
  const matches: t.JSXElement[] = [];
  const ast = parse(source, { sourceType: "unambiguous", plugins: ["jsx", "typescript"] });
  t.traverseFast(ast, (node) => {
    if (t.isJSXElement(node)) matches.push(node);
  });
  return matches;
}

function literalText(element: t.JSXElement, includeChildren = false): string | null {
  let text = "";
  for (const child of element.children) {
    if (t.isJSXText(child)) text += child.value;
    else if (t.isJSXExpressionContainer(child) && t.isStringLiteral(child.expression))
      text += child.expression.value;
    else if (
      includeChildren &&
      t.isJSXElement(child) &&
      t.isJSXIdentifier(child.openingElement.name) &&
      /^[a-z]/.test(child.openingElement.name.name)
    ) {
      const nested = literalText(child, true);
      if (nested === null) return null;
      text += nested;
    } else return null;
  }
  return text;
}

export function canEditDesignText(source: string): boolean {
  const element = elements(source)[0];
  return !!element?.closingElement && literalText(element) !== null;
}

export function findDesignSources(source: string, target: DesignTarget): string[] {
  try {
    return elements(source)
      .filter((element, index) => {
        if (target.sourceIndex !== undefined) {
          return (
            index === target.sourceIndex &&
            t.isJSXIdentifier(element.openingElement.name, { name: target.tagName })
          );
        }
        const name = element.openingElement.name;
        const text = literalText(element, true);
        return (
          t.isJSXIdentifier(name) &&
          name.name === target.tagName &&
          text !== null &&
          normalizeText(text) === normalizeText(target.text)
        );
      })
      .map((element) => source.slice(element.start ?? 0, element.end ?? 0));
  } catch {
    return [];
  }
}

const spacingSides = {
  padding: ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"],
  margin: ["marginTop", "marginRight", "marginBottom", "marginLeft"],
} satisfies Record<string, readonly DesignProperty[]>;

export function editDesignSource(source: string, property: DesignProperty, value: string): string {
  if (property === "padding" || property === "margin") {
    const parts = value.trim().split(/\s+/);
    if (parts.length < 1 || parts.length > 4)
      throw new BrowserDesignError({ reason: "unsupported" });
    const [top = "", right = top, bottom = top, left = right] = parts;
    const values = [top, right, bottom, left];
    return spacingSides[property].reduce(
      (current, side, index) => editDesignSource(current, side, values[index] ?? top),
      source,
    );
  }
  if (value.length > 8192) throw new BrowserDesignError({ reason: "unsupported" });
  const ast = parse(`const __design = (${source});`, {
    sourceType: "module",
    plugins: ["jsx", "typescript"],
  });
  const statement = ast.program.body[0];
  const element = t.isVariableDeclaration(statement) ? statement.declarations[0]?.init : null;
  if (!t.isJSXElement(element) || element.start === null || element.start === undefined)
    throw new BrowserDesignError({ reason: "unsupported" });
  const offset = element.start;
  if (property === "textContent") {
    if (literalText(element) === null || !element.closingElement)
      throw new BrowserDesignError({ reason: "unsupported" });
    return (
      source.slice(0, (element.openingElement.end ?? offset) - offset) +
      `{${JSON.stringify(value)}}` +
      source.slice((element.closingElement.start ?? offset) - offset)
    );
  }
  // Arbitrary CSS expressions and URLs are left to the agent. Controls write literal values only.
  if (!/^[#\w\s.,()%+\-/]*$/.test(value) || /url\s*\(/i.test(value))
    throw new BrowserDesignError({ reason: "unsupported" });
  const opening = element.openingElement;
  if (opening.attributes.some((attribute) => t.isJSXSpreadAttribute(attribute)))
    throw new BrowserDesignError({ reason: "unsupported" });
  const style = opening.attributes.find(
    (attribute) =>
      t.isJSXAttribute(attribute) && t.isJSXIdentifier(attribute.name, { name: "style" }),
  );
  const serialized = JSON.stringify(value);
  if (!style) {
    const position = (opening.end ?? offset) - offset - (opening.selfClosing ? 2 : 1);
    return (
      source.slice(0, position) + ` style={{ ${property}: ${serialized} }}` + source.slice(position)
    );
  }
  if (
    !t.isJSXAttribute(style) ||
    !t.isJSXExpressionContainer(style.value) ||
    !t.isObjectExpression(style.value.expression)
  )
    throw new BrowserDesignError({ reason: "unsupported" });
  const object = style.value.expression;
  if (
    object.properties.some(
      (entry) =>
        !t.isObjectProperty(entry) ||
        entry.computed ||
        (!t.isStringLiteral(entry.value) && !t.isNumericLiteral(entry.value)),
    )
  )
    throw new BrowserDesignError({ reason: "unsupported" });
  const existing = object.properties.find(
    (entry) =>
      t.isObjectProperty(entry) &&
      ((t.isIdentifier(entry.key) && entry.key.name === property) ||
        (t.isStringLiteral(entry.key) && entry.key.value === property)),
  );
  if (existing && t.isObjectProperty(existing)) {
    return (
      source.slice(0, (existing.value.start ?? offset) - offset) +
      serialized +
      source.slice((existing.value.end ?? offset) - offset)
    );
  }
  const position = (object.end ?? offset) - offset - 1;
  const prefix = source.slice(0, position);
  return (
    prefix +
    (object.properties.length > 0 && !prefix.trimEnd().endsWith(",") ? "," : "") +
    ` ${property}: ${serialized} ` +
    source.slice(position)
  );
}

function styleParts(element: t.JSXElement, source: string, property: DesignProperty) {
  const attribute = element.openingElement.attributes.find(
    (entry) => t.isJSXAttribute(entry) && t.isJSXIdentifier(entry.name, { name: "style" }),
  );
  if (!attribute) return { attribute: null, object: null, property: null, value: null };
  if (
    !t.isJSXAttribute(attribute) ||
    !t.isJSXExpressionContainer(attribute.value) ||
    !t.isObjectExpression(attribute.value.expression)
  )
    throw new BrowserDesignError({ reason: "conflict" });
  const object = attribute.value.expression;
  if (object.properties.some((entry) => !t.isObjectProperty(entry) || entry.computed))
    throw new BrowserDesignError({ reason: "conflict" });
  const entry = object.properties.find(
    (entry) =>
      t.isObjectProperty(entry) &&
      ((t.isIdentifier(entry.key) && entry.key.name === property) ||
        (t.isStringLiteral(entry.key) && entry.key.value === property)),
  );
  const found = entry && t.isObjectProperty(entry) ? entry : null;
  return {
    attribute,
    object,
    property: found,
    value: found ? source.slice(found.value.start ?? 0, found.value.end ?? 0) : null,
  };
}

/** Re-locate the literal being changed, so unrelated attributes in the same element survive undo. */
export function applyDesignPatch(
  contents: string,
  before: string,
  after: string,
  property: DesignProperty,
  sourceIndex?: number,
): string {
  const original = elements(before)[0];
  const desired = elements(after)[0];
  if (!original || !desired) throw new BrowserDesignError({ reason: "conflict" });
  if (
    (property === "padding" || property === "margin") &&
    styleParts(original, before, property).value === styleParts(desired, after, property).value
  ) {
    return spacingSides[property].reduce(
      (current, side) => applyDesignPatch(current, before, after, side, sourceIndex),
      contents,
    );
  }
  const tag = original.openingElement.name;
  if (!t.isJSXIdentifier(tag)) throw new BrowserDesignError({ reason: "conflict" });
  const expectedStyle = property === "textContent" ? null : styleParts(original, before, property);
  const children = (element: t.JSXElement, source: string) =>
    source.slice(
      element.openingElement.end ?? 0,
      element.closingElement?.start ?? element.openingElement.end ?? 0,
    );
  const attributes = (element: t.JSXElement, source: string) =>
    element.openingElement.attributes
      .filter(
        (attribute) =>
          !t.isJSXAttribute(attribute) || !t.isJSXIdentifier(attribute.name, { name: "style" }),
      )
      .map((attribute) => source.slice(attribute.start ?? 0, attribute.end ?? 0))
      .join(" ");
  const matches = elements(contents).filter((candidate, index) => {
    if (sourceIndex !== undefined && index !== sourceIndex) return false;
    const name = candidate.openingElement.name;
    if (
      !t.isJSXIdentifier(name) ||
      name.name !== tag.name ||
      (sourceIndex === undefined
        ? literalText(candidate, true) === null ||
          literalText(candidate, true) !== literalText(original, true)
        : children(candidate, contents) !== children(original, before) ||
          attributes(candidate, contents) !== attributes(original, before))
    )
      return false;
    if (property === "textContent") return true;
    try {
      return styleParts(candidate, contents, property).value === expectedStyle?.value;
    } catch {
      return false;
    }
  });
  const current = matches[0];
  if (matches.length !== 1 || !current) throw new BrowserDesignError({ reason: "conflict" });
  const replace = (start: number, end: number, value: string) =>
    contents.slice(0, start) + value + contents.slice(end);
  if (property === "textContent") {
    if (!desired.closingElement || !current.closingElement)
      throw new BrowserDesignError({ reason: "conflict" });
    return replace(
      current.openingElement.end ?? 0,
      current.closingElement.start ?? 0,
      after.slice(desired.openingElement.end ?? 0, desired.closingElement.start ?? 0),
    );
  }
  const target = styleParts(current, contents, property);
  const goal = styleParts(desired, after, property);
  if (goal.value !== null) {
    if (target.property)
      return replace(target.property.value.start ?? 0, target.property.value.end ?? 0, goal.value);
    if (!target.object) {
      const point =
        (current.openingElement.end ?? 0) - (current.openingElement.selfClosing ? 2 : 1);
      return replace(point, point, ` style={{ ${property}: ${goal.value} }}`);
    }
    const point = (target.object.end ?? 0) - 1;
    const prefix = contents.slice(0, point);
    return replace(
      point,
      point,
      (target.object.properties.length > 0 && !prefix.trimEnd().endsWith(",") ? "," : "") +
        ` ${property}: ${goal.value} `,
    );
  }
  if (!target.property || !target.object || !target.attribute) return contents;
  if (target.object.properties.length === 1 && !goal.attribute) {
    let start = target.attribute.start ?? 0;
    while (start > 0 && /[ \t]/.test(contents[start - 1] ?? "")) start--;
    return replace(start, target.attribute.end ?? start, "");
  }
  let start = target.property.start ?? 0;
  let end = target.property.end ?? start;
  while (/\s/.test(contents[end] ?? "")) end++;
  if (contents[end] === ",") end++;
  else {
    while (start > 0 && /\s/.test(contents[start - 1] ?? "")) start--;
    if (contents[start - 1] === ",") start--;
  }
  return replace(start, end, "");
}
