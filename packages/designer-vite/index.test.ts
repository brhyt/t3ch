import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { t3chDesigner } from "./index.mjs";

describe("React/Vite Designer connection", () => {
  it("maps conditional, repeated and self-closing elements without changing their expressions", () => {
    const plugin = t3chDesigner();
    plugin.configResolved({ root: "/project" });
    const source =
      'const View = () => <section><h2>{preview ? "Preview" : "Make it a date."}</h2>{items.map(item => <p>{item.name}</p>)}<img src="cover.png" /></section>';
    const result = plugin.transform(source, "/project/src/View.tsx");
    expect(result?.code).toContain('{preview ? "Preview" : "Make it a date."}');
    expect(result?.code).toContain("items.map(item => <p");
    expect(result?.code.match(/data-t3ch-source=/g)).toHaveLength(4);
    expect(result?.code).toContain(NodeCrypto.createHash("sha256").update(source).digest("hex"));
    expect(result?.code).toContain('\\"index\\":1');
    expect(result?.map.sourcesContent).toEqual([source]);
    expect(plugin.apply).toBe("serve");
    expect(plugin.transform(source, "/other/View.tsx")).toBeNull();
    expect(plugin.transform(source, "/project/node_modules/widget/View.tsx")).toBeNull();
  });
});
