import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({ files: new Map<string, string>(), sequence: 0 }));
vi.mock("../lib/uuid", () => ({ uuidv4: () => `retry-${++state.sequence}` }));
vi.mock("expo-file-system", () => ({
  Paths: { document: "/documents" },
  Directory: class {
    create() {}
  },
  File: class {
    constructor(
      _directory: unknown,
      readonly name: string,
    ) {}
    get exists() {
      return state.files.has(this.name);
    }
    async text() {
      return state.files.get(this.name);
    }
    delete() {
      state.files.delete(this.name);
    }
  },
}));
vi.mock("../lib/atomic-file", () => ({
  writeFileAtomically: async (file: { name: string }, contents: string) => {
    state.files.set(file.name, contents);
  },
}));
import { clearMultitaskRetry, loadOrCreateMultitaskRetry } from "./multitask-retry";

beforeEach(() => {
  state.files.clear();
  state.sequence = 0;
});
describe("mobile durable parallel task identity", () => {
  it("reconstructs the same request after retry storage is reopened", async () => {
    expect(await loadOrCreateMultitaskRetry("environment:thread", "draft-a")).toEqual({
      key: "draft-a",
      commandId: "retry-1",
      messageId: "retry-2",
    });
    expect(await loadOrCreateMultitaskRetry("environment:thread", "draft-a")).toEqual({
      key: "draft-a",
      commandId: "retry-1",
      messageId: "retry-2",
    });
    expect(await loadOrCreateMultitaskRetry("environment:other", "draft-a")).toEqual({
      key: "draft-a",
      commandId: "retry-3",
      messageId: "retry-4",
    });
  });
  it("allocates a new identity for changed or accepted drafts", async () => {
    await loadOrCreateMultitaskRetry("thread", "draft-a");
    expect((await loadOrCreateMultitaskRetry("thread", "draft-b")).commandId).toBe("retry-3");
    await clearMultitaskRetry("thread");
    expect((await loadOrCreateMultitaskRetry("thread", "draft-b")).commandId).toBe("retry-5");
  });
  it("refuses corrupt storage rather than risking a duplicate task", async () => {
    state.files.set("thread.json", "invalid");
    await expect(loadOrCreateMultitaskRetry("thread", "draft-a")).rejects.toThrow();
    expect(state.sequence).toBe(0);
  });
});
