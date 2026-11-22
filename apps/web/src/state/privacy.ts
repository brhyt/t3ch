import { createPrivacyAtoms } from "@t3tools/client-runtime/state/privacy";
import { connectionAtomRuntime } from "../connection/runtime";
export const privacy = createPrivacyAtoms(connectionAtomRuntime);
