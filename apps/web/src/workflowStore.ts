import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import * as Schema from "effect/Schema";
import { WorkflowConfig } from "./workflowConfig";
import { resolveStorage } from "./lib/storage";

const Configurations = Schema.Record(Schema.String, WorkflowConfig);
const decode = Schema.decodeUnknownOption(Configurations);
export const useWorkflowStore = create<{
  byThread: Record<string, WorkflowConfig>;
  select: (key: string, config: WorkflowConfig | null) => void;
}>()(
  persist(
    (set) => ({
      byThread: {},
      select: (key, config) =>
        set((state) => {
          const byThread = { ...state.byThread };
          if (config) byThread[key] = config;
          else delete byThread[key];
          return { byThread };
        }),
    }),
    {
      name: "t3ch:workflows:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byThread: state.byThread }),
      merge: (saved, current) => {
        const decoded = decode(
          typeof saved === "object" && saved !== null && "byThread" in saved ? saved.byThread : {},
        );
        return { ...current, byThread: decoded._tag === "Some" ? decoded.value : {} };
      },
    },
  ),
);
