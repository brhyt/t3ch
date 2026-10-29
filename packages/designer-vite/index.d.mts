import type { SourceMap } from "magic-string";
export function t3chDesigner(): {
  name: string;
  apply: "serve";
  enforce: "pre";
  configResolved(config: { root: string }): void;
  transform(code: string, id: string): { code: string; map: SourceMap } | null;
};
