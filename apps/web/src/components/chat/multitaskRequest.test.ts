import { describe, expect, it } from "vite-plus/test";
import { acknowledgeMultitaskRequest, multitaskRequest } from "./multitaskRequest";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe("Multitask request recovery", () => {
  it("reuses the accepted request after a lost response and a composer reload", () => {
    const saved = storage();
    const first = multitaskRequest(saved, "thread-a", "same draft and model");
    const afterReload = multitaskRequest(saved, "thread-a", "same draft and model");
    expect(afterReload).toEqual(first);
    expect(afterReload.messageId).not.toBe(afterReload.commandId);
  });

  it("separates changed drafts and threads and never acknowledges a newer request", () => {
    const saved = storage();
    const first = multitaskRequest(saved, "thread-a", "old");
    const next = multitaskRequest(saved, "thread-a", "new");
    const otherThread = multitaskRequest(saved, "thread-b", "new");
    expect(next.commandId).not.toBe(first.commandId);
    expect(otherThread.commandId).not.toBe(next.commandId);
    acknowledgeMultitaskRequest(saved, "thread-a", first.commandId);
    expect(multitaskRequest(saved, "thread-a", "new")).toEqual(next);
    acknowledgeMultitaskRequest(saved, "thread-a", next.commandId);
    expect(multitaskRequest(saved, "thread-a", "new").commandId).not.toBe(next.commandId);
  });
});
