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
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <h3 className="font-medium">
        <span>Recurring findings</span>
      </h3>
      <p className="text-sm text-muted-foreground">
        <span>
          Direct traffic is unobserved. A configured proxy or an empty journal does not establish
          coverage. Findings are masked signals for investigation, not proof of a leak.
        </span>
      </p>
      <p className="text-sm text-muted-foreground">
        <span>
          Authentication-shaped headers are not proof of an authorized or expected destination.
          Detection type and location describe potential exposure; inspection gaps describe missing
          evidence.
        </span>
      </p>
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
              <details>
                <summary className="cursor-pointer">
                  <span>Finding detail</span>
                </summary>
                <p className="mt-2">
                  <span>Severity, confidence and destination expectation: unknown</span>
                  <span>Historical detection context and launch evidence: unknown.</span>
                </p>
                <p>
                  <span>First seen</span>: {new Date(issue.firstSeen * 1000).toLocaleString()}
                </p>
                <p>
                  <span>Last reviewed</span>:{" "}
                  {issue.reviewedAt ? (
                    new Date(issue.reviewedAt * 1000).toLocaleString()
                  ) : (
                    <span>Not reviewed</span>
                  )}
                </p>
                <p>
                  <span>
                    Counts cover retained finding history, not all traffic. Reviewed does not mean
                    verified fixed.
                  </span>
                </p>
              </details>
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
          {journal.issues === undefined ? (
            <span>Finding history is unavailable from this observer.</span>
          ) : (
            <span>No retained findings. This does not establish that traffic is safe.</span>
          )}
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
