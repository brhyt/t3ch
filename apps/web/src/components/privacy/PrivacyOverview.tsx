import type { PrivacyJournal } from "@t3tools/contracts";

export function PrivacyOverview({
  journal,
  refreshing,
  fetchedAt,
}: {
  journal: PrivacyJournal;
  refreshing: boolean;
  fetchedAt: number;
}) {
  const tracking = journal.tracking;
  return (
    <div className="space-y-4">
      <section className="rounded-lg border p-4">
        <h3 className="font-medium">
          <span>Observer evidence</span>
        </h3>
        <p className="mt-2 text-sm" role="status">
          {refreshing ? (
            <span>Refreshing observer snapshot</span>
          ) : (
            <span>Snapshot available; continuous health is not verified</span>
          )}
        </p>
        <p className="mt-2 break-all text-sm">
          <span>Component / version</span>:{" "}
          {journal.component ? (
            `${journal.component.name} / ${journal.component.version} (${journal.component.identityKind})`
          ) : (
            <span>Unknown</span>
          )}
        </p>
        <p className="mt-2 text-sm">
          <span>Snapshot generated</span>:{" "}
          {journal.generatedAt ? (
            new Date(journal.generatedAt * 1000).toLocaleString()
          ) : (
            <span>Unknown</span>
          )}
        </p>
        <p className="mt-2 text-sm">
          <span>Fetched at</span>:{" "}
          {fetchedAt ? new Date(fetchedAt).toLocaleString() : <span>Unknown</span>}
        </p>
        <p className="mt-2 text-sm">
          <span>Observation window</span>:{" "}
          {journal.observationWindow ? (
            <>
              {new Date(journal.observationWindow.startedAt * 1000).toLocaleString()} –{" "}
              {new Date(journal.observationWindow.endedAt * 1000).toLocaleString()} ·{" "}
              {journal.observationWindow.retainedEvents}
            </>
          ) : (
            <span>Unknown</span>
          )}
        </p>
        {journal.observationWindow?.truncated ? (
          <p>
            <span>Evidence is incomplete.</span>
          </p>
        ) : null}
        <p className="mt-2 text-sm text-muted-foreground">
          <span>Last observation</span>:{" "}
          {tracking?.lastObservedAt ? (
            new Date(tracking.lastObservedAt * 1000).toLocaleString()
          ) : (
            <span>Unknown or none this session</span>
          )}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {journal.label} · {journal.coverage}
        </p>
      </section>
      <div className="grid gap-3 sm:grid-cols-3">
        <section className="rounded-lg border p-4">
          <p className="text-2xl font-semibold">{journal.events.length}</p>
          <h3 className="text-sm">
            <span>Retained observations</span>
          </h3>
        </section>
        <section className="rounded-lg border p-4">
          <p className="text-2xl font-semibold">
            {journal.issues ? (
              journal.issues.filter((issue) => issue.state === "open").length
            ) : (
              <span>Unknown</span>
            )}
          </p>
          <h3 className="text-sm">
            <span>Needs review</span>
          </h3>
        </section>
        <section className="rounded-lg border p-4">
          <p className="text-2xl font-semibold">
            <span>Unknown</span>
          </p>
          <h3 className="text-sm">
            <span>Direct and mobile coverage</span>
          </h3>
        </section>
      </div>
      <section className="space-y-2 rounded-lg border p-4 text-sm">
        <h3 className="font-medium">
          <span>Coverage gaps</span>
        </h3>
        <p>
          <span>
            Only traffic routed through this observer is visible. An empty journal is not evidence
            of safety.
          </span>
        </p>
        <p className="text-muted-foreground">
          <span>
            Provider and session attribution are unknown. Source labels are operator-supplied. Other
            clients and self-hosted services need separate observation.
          </span>
        </p>
        <details>
          <summary className="cursor-pointer">
            <span>Retention and inspection limits</span>
          </summary>
          <p className="mt-2">
            <span>
              Up to 2,000 live events are retained in memory and lost on restart or clearing.
              Pattern detection can miss encoded or unsupported content. Raw payloads and matched
              values are not saved.
            </span>
          </p>
          <p className="mt-2">
            <span>
              Experiments persist until manually deleted; clearing live events does not delete
              experiments.
            </span>
          </p>
          {tracking ? (
            <p className="mt-2">
              {tracking.retentionDays}{" "}
              <span>
                days since the latest occurrence before a finding expires. Earlier counts can
                predate this window.
              </span>{" "}
              ·{" "}
              {tracking.persistent && !tracking.persistenceError ? (
                <span>Persistent findings available</span>
              ) : (
                <span>Persistent findings unavailable</span>
              )}
            </p>
          ) : null}
        </details>
      </section>
    </div>
  );
}
