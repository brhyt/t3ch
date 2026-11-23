import type { PrivacyJournal } from "@t3tools/contracts";
type Event = PrivacyJournal["events"][number];
export function PrivacyEventEvidence({ event }: { event: Event }) {
  const attribution = event.launchAttribution;
  return (
    <div className="my-2 space-y-1 break-all text-muted-foreground">
      <div>
        <span>Launch evidence</span>: {attribution?.evidence ?? "unknown"}
      </div>
      <div>
        <span>Initiating component</span>: {attribution?.component ?? "unknown"}
      </div>
      <div>
        <span>Provider instance</span>: {attribution?.providerInstanceId ?? "unknown"}
      </div>
      <div>
        <span>Opaque launch ID</span>: {attribution?.launchId ?? "unknown"}
      </div>
      <div>
        <span>Launch origin thread</span>: {attribution?.initiatingThreadId ?? "unknown"}
      </div>
      <p>
        <span>
          Workflow remains unknown. Launch evidence cannot prove a user request or model cause.
          Copied credentials and shared hosts limit attribution.
        </span>
      </p>
      <div>
        <span>Stage evidence</span>:{" "}
        {event.stages
          ? Object.entries(event.stages)
              .map(([stage, evidence]) => `${stage}: ${evidence}`)
              .join(" · ")
          : "unknown"}
      </div>
    </div>
  );
}
export function PrivacyFindingEvidence({ finding }: { finding: Event["findings"][number] }) {
  return (
    <div className="text-muted-foreground">
      <div>
        <span>Detector</span>: {finding.detectorId ?? "unknown"}
      </div>
      <div>
        <span>Detection context</span>: {finding.context ?? "unknown"}
      </div>
      <div>
        <span>Destination expectation</span>: {finding.destinationExpectation ?? "unknown"}
      </div>
      <div>
        <span>Value presence</span>: {finding.valuePresence ?? "unknown"}
      </div>
      <div>
        <span>Value type</span>: {finding.valueType ?? "unknown"}
      </div>
    </div>
  );
}
