import { createFileRoute, redirect } from "@tanstack/react-router";

import { PrivacyPage } from "../components/privacy/PrivacyPage";

export const Route = createFileRoute("/privacy")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: PrivacyPage,
});
