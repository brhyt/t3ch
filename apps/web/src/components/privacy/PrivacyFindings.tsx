import type { PrivacyJournal, PrivacyRule } from "@t3tools/contracts";
import { Button } from "../ui/button";

export function PrivacyFindings({
  journal,
  canChange,
  pending,
  apply,
}: {
  journal: PrivacyJournal;
  canChange: boolean;
  pending: boolean;
  apply: (rule: PrivacyRule) => Promise<void>;
}) {
  const tracking = journal.tracking;
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <h3 className="font-medium">
        <span>Coverage and recurring findings</span>
      </h3>
      <p className="text-sm text-muted-foreground">
        <span>
          Direct traffic is unobserved. A configured proxy or an empty journal does not establish
          coverage. Findings are masked signals for investigation, not proof of a leak.
        </span>
      </p>
      {tracking ? (
        <div className="space-y-1 text-sm">
          <p>
            {tracking.observedThisSession} <span>requests observed this observer session</span>
          </p>
          <p>
            <span>Last observation</span>:{" "}
            {tracking.lastObservedAt === null ? (
              <span>None this session</span>
            ) : (
              new Date(tracking.lastObservedAt * 1000).toLocaleString()
            )}
          </p>
          <p>
            {tracking.persistent && !tracking.persistenceError ? (
              <span>Masked findings persist across observer restarts.</span>
            ) : (
              <span>
                Persistent findings are unavailable. This session alone cannot track recurrence
                across restarts.
              </span>
            )}
          </p>
          <p>
            {tracking.retentionDays} <span>days maximum findings retention</span>
          </p>
        </div>
      ) : (
        <p className="text-sm">
          <span>Update this observer to report session coverage and persistent findings.</span>
        </p>
      )}
      {journal.issues?.length ? (
        <div className="space-y-2">
          {journal.issues.map((issue) => (
            <div key={issue.id} className="space-y-1 rounded border p-3 text-sm">
              <p className="break-all font-medium">
                {issue.host} · {issue.kind}
              </p>
              <p className="text-muted-foreground">
                {issue.source} · {issue.location} · {issue.occurrences} <span>occurrences</span> ·{" "}
                {issue.blocked} <span>blocked</span>
              </p>
              <p>
                {issue.state === "reviewed" ? (
                  <span>Reviewed; not certified fixed</span>
                ) : (
                  <span>Needs review</span>
                )}{" "}
                · {new Date(issue.lastSeen * 1000).toLocaleString()}
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={!canChange || pending}
                onClick={() =>
                  void apply({
                    action: issue.state === "reviewed" ? "reopen-finding" : "review-finding",
                    findingId: issue.id,
                  })
                }
              >
                {issue.state === "reviewed" ? <span>Reopen</span> : <span>Mark reviewed</span>}
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm">
          <span>No retained findings. This does not establish that traffic is safe.</span>
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        <span>
          A new matching event reopens a reviewed finding. Clearing the live journal preserves this
          history.
        </span>
      </p>
    </section>
  );
}
