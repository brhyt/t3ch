import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { parse } from "@babel/parser";
import { isJSXElement, isJSXIdentifier, traverseFast } from "@babel/types";
import MagicString from "magic-string";

/** Development-only references. Production builds contain no Designer metadata. */
export function t3chDesigner() {
  let root = "";
  return {
    name: "t3ch-designer",
    apply: "serve",
    enforce: "pre",
    configResolved(config) {
      root = config.root;
    },
    transform(code, id) {
      const file = id.split("?")[0];
      if (!/\.[jt]sx$/.test(file) || /[/\\](node_modules|\.git)[/\\]/.test(file)) return null;
      const local = NodePath.relative(root, file);
      if (local === ".." || local.startsWith("../") || NodePath.isAbsolute(local)) return null;
      const ast = parse(code, { sourceType: "unambiguous", plugins: ["jsx", "typescript"] });
      const revision = NodeCrypto.createHash("sha256").update(code).digest("hex");
      const result = new MagicString(code);
      let index = 0;
      traverseFast(ast, (node) => {
        if (!isJSXElement(node)) return;
        const elementIndex = index++;
        const opening = node.openingElement;
        if (!isJSXIdentifier(opening.name) || !/^[a-z]/.test(opening.name.name)) return;
        const reference = JSON.stringify({
          file: NodePath.resolve(file),
          index: elementIndex,
          revision,
        });
        // Append after spreads so component props cannot replace the reference.
        result.appendLeft(
          opening.end - (opening.selfClosing ? 2 : 1),
          ` data-t3ch-source={${JSON.stringify(reference)}}`,
        );
      });
      if (!result.hasChanged()) return null;
      return {
        code: result.toString(),
        map: result.generateMap({ hires: true, source: file, includeContent: true }),
      };
    },
  };
}
