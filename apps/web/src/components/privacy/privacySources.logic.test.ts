import { expect, it } from "vite-plus/test";
import { mayChangeSource, readSourceCatalog } from "./privacySources.logic";
it("requires both caller and primary source permission at mutation time", () => {
  expect(mayChangeSource(true, "honcho", true)).toBe(false);
  expect(mayChangeSource(false, "primary", true)).toBe(false);
  expect(mayChangeSource(true, "primary", false)).toBe(false);
  expect(mayChangeSource(true, "primary", true)).toBe(true);
});
it("rejects malformed catalogs instead of assuming healthy sources", () => {
  for (const value of [
    null,
    {},
    { configuration: "valid", sources: [] },
    { configuration: "valid", sources: [{ id: "primary" }] },
  ])
    expect(readSourceCatalog(value)).toBeNull();
});
