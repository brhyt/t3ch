import { describe, expect, it } from "@effect/vitest";

import { mobileSupportsThreadConversations } from "./threadConversations";

describe("mobile thread conversations", () => {
  it("keeps conversation controls hidden unless the server advertises support", () => {
    expect(mobileSupportsThreadConversations(undefined)).toBe(false);
    expect(mobileSupportsThreadConversations({})).toBe(false);
    expect(mobileSupportsThreadConversations({ threadConversations: false })).toBe(false);
    expect(mobileSupportsThreadConversations({ threadConversations: true })).toBe(true);
  });
});
