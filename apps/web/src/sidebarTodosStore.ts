import type { EnvironmentId, ThreadConversationId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export type SidebarListView = "threads" | "todos";

interface SidebarTodosState {
  view: SidebarListView;
  /** The machine the sidebar lists; null lists every machine. */
  machineEnvironmentId: EnvironmentId | null;
  setView: (view: SidebarListView) => void;
  setMachineEnvironmentId: (environmentId: EnvironmentId | null) => void;
}

/** T3CH sidebar choices, persisted per client. */
export const useSidebarTodosStore = create<SidebarTodosState>()(
  persist(
    (set) => ({
      view: "threads",
      machineEnvironmentId: null,
      setView: (view) => set({ view }),
      setMachineEnvironmentId: (machineEnvironmentId) => set({ machineEnvironmentId }),
    }),
    {
      name: "t3ch:sidebar-todos:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ view, machineEnvironmentId }) => ({ view, machineEnvironmentId }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<SidebarTodosState> | null;
        return {
          ...current,
          view: saved?.view === "todos" ? "todos" : "threads",
          machineEnvironmentId:
            typeof saved?.machineEnvironmentId === "string"
              ? (saved.machineEnvironmentId as EnvironmentId)
              : null,
        };
      },
    },
  ),
);

interface ThreadTopicFocusState {
  /** The topic each thread's timeline is narrowed to, by scoped thread key. */
  byThreadKey: Readonly<Record<string, ThreadConversationId>>;
  focus: (threadKey: string, conversationId: ThreadConversationId | null) => void;
}

/**
 * Lives outside ChatView so the sidebar's to-do list can open a thread on a topic
 * and highlight the to-do that is open.
 */
export const useThreadTopicFocusStore = create<ThreadTopicFocusState>()((set) => ({
  byThreadKey: {},
  focus: (threadKey, conversationId) =>
    set((state) => {
      if ((state.byThreadKey[threadKey] ?? null) === conversationId) return state;
      const { [threadKey]: _previous, ...rest } = state.byThreadKey;
      return {
        byThreadKey: conversationId === null ? rest : { ...rest, [threadKey]: conversationId },
      };
    }),
}));
