"use client";

import { useAtomRefresh } from "@effect/atom-react";
import {
  AuthPreviewOperateScope,
  sessionGrantsScope,
  type PreviewAnnotationPayload,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import type { ComposerImageAttachment } from "~/composerDraftStore";
import { usePreviewAvailable } from "~/browser/previewRuntime";
import { environmentSession, useEnvironmentSessionState } from "~/state/session";
import { Button } from "~/components/ui/button";

import { PreviewPanelShell, type PreviewPanelMode } from "./PreviewPanelShell";
import { PreviewView } from "./PreviewView";

interface Props {
  mode: PreviewPanelMode;
  threadRef: ScopedThreadRef;
  tabId?: string | null;
  configuredUrls?: ReadonlyArray<string> | undefined;
  visible: boolean;
  onSendAnnotation?: (
    annotation: PreviewAnnotationPayload,
    image: ComposerImageAttachment | null,
  ) => void;
}

export function PreviewPanel({
  mode,
  threadRef,
  tabId,
  configuredUrls,
  visible,
  onSendAnnotation,
}: Props) {
  const available = usePreviewAvailable(threadRef.environmentId);
  const session = useEnvironmentSessionState(threadRef.environmentId);
  const refreshSession = useAtomRefresh(
    environmentSession.sessionStateAtom(threadRef.environmentId),
  );
  const canOperatePreview =
    !session.hasError &&
    session.data !== null &&
    sessionGrantsScope(session.data, AuthPreviewOperateScope);
  if (!canOperatePreview || !available) {
    const message = session.hasError
      ? "Could not check preview access. Retry the connection."
      : session.data === null
        ? "Connecting to the environment to check preview access…"
        : !canOperatePreview
          ? "Pair this client again with preview access to control browser previews."
          : "Browser preview is unavailable in this environment.";
    return (
      <PreviewPanelShell mode={mode}>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="max-w-sm text-sm text-muted-foreground">{message}</p>
          {(session.hasError || (session.data !== null && !canOperatePreview)) && (
            <Button variant="outline" size="sm" onClick={refreshSession}>
              Retry access check
            </Button>
          )}
        </div>
      </PreviewPanelShell>
    );
  }

  return (
    <PreviewPanelShell mode={mode}>
      <PreviewView
        threadRef={threadRef}
        {...(tabId !== undefined ? { tabId } : {})}
        configuredUrls={configuredUrls}
        visible={visible}
        {...(onSendAnnotation ? { onSendAnnotation } : {})}
      />
    </PreviewPanelShell>
  );
}
