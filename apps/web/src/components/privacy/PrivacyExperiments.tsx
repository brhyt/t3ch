import type { PrivacyJournal, PrivacyRule } from "@t3tools/contracts";
import { useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function PrivacyExperiments({
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
  const [host, setHost] = useState("");
  const [duration, setDuration] = useState("300");
  const available =
    journal.policyStorage?.status === "ready" && !journal.policyStorage.persistenceError;
  return (
    <section className="space-y-4 rounded-lg border p-4">
      <h3 className="font-medium">
        <span>Compare baseline, block and recovery</span>
      </h3>
      <ol className="list-decimal space-y-2 ps-5 text-sm">
        <li>
          <span>Run your task through this proxy to collect a baseline for the exact host.</span>
        </li>
        <li>
          <span>
            Start a timed block, then retry the same task. Record the task result yourself.
          </span>
        </li>
        <li>
          <span>
            Restore access and retry to collect recovery evidence, then finish the experiment.
          </span>
        </li>
      </ol>
      <p className="text-sm text-muted-foreground">
        <span>
          Blocks affect every client sharing this proxy. Provider and session scope are unknown. The
          block expires automatically; response counts do not establish task success.
        </span>
      </p>
      {!canChange ? (
        <p className="text-sm text-muted-foreground">
          <span>Settings permission is required to change rules or clear observations.</span>
        </p>
      ) : null}
      {!available ? (
        <p role="status" className="text-sm">
          <span>
            Experiments require an observer with durable policy storage. Refresh after upgrading or
            restoring storage.
          </span>
        </p>
      ) : null}
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (available && canChange && !pending)
            void apply({
              action: "start-experiment",
              host: host.trim(),
              durationSeconds: Number(duration),
            });
        }}
      >
        <label className="space-y-1 text-sm">
          <span>
            <span>Exact hostname</span>
          </span>
          <Input
            value={host}
            onChange={(event) => setHost(event.target.value)}
            required
            disabled={!available || !canChange || pending}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span>
            <span>Block duration</span>
          </span>
          <select
            className="block rounded border bg-background p-2"
            value={duration}
            onChange={(event) => setDuration(event.target.value)}
            disabled={!available || !canChange || pending}
          >
            <option value="60">{"1 minute"}</option>
            <option value="300">{"5 minutes"}</option>
            <option value="900">{"15 minutes"}</option>
          </select>
        </label>
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={!available || !canChange || pending || !host.trim()}
        >
          <span>Start timed block</span>
        </Button>
      </form>
      {journal.blocked.length ? (
        <section className="space-y-2 border-t pt-3">
          <h4 className="font-medium">
            <span>Current proxy blocks</span>
          </h4>
          {journal.blocked.map((blockedHost) => {
            const saved = journal.rules?.some(
              (rule) => rule.host === blockedHost && rule.kind === "saved",
            );
            return (
              <div
                key={blockedHost}
                className="flex flex-wrap items-center justify-between gap-2 text-sm"
              >
                <span className="break-all">{blockedHost}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canChange || pending}
                  onClick={() =>
                    void apply({ action: saved ? "remove-policy" : "unblock", host: blockedHost })
                  }
                >
                  {saved ? <span>Remove saved block</span> : <span>Unblock</span>}
                </Button>
              </div>
            );
          })}
        </section>
      ) : null}
      {journal.experiments?.map((experiment) => (
        <article className="space-y-3 rounded border p-3 text-sm" key={experiment.id}>
          <h4 className="break-all font-medium">{experiment.host}</h4>
          {experiment.evidenceIncomplete ? (
            <p role="status">
              <span>
                Evidence is incomplete. Some observations may have been cleared, evicted or
                interrupted by restart.
              </span>
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            <span>Baseline window</span>:{" "}
            {experiment.baselineStartedAt === null ? (
              <span>No retained baseline</span>
            ) : (
              new Date(experiment.baselineStartedAt * 1000).toLocaleString()
            )}{" "}
            – {new Date(experiment.baselineEndedAt * 1000).toLocaleString()}
          </p>
          <p>
            {experiment.phase === "blocked" ? (
              <span>Block active</span>
            ) : experiment.phase === "recovery" ? (
              <span>Collecting recovery</span>
            ) : (
              <span>Finished collecting</span>
            )}{" "}
            · <span>Task outcome unknown</span>
          </p>
          <p>
            <span>Block expiry</span>: {new Date(experiment.expiresAt * 1000).toLocaleString()}
          </p>
          <div className="overflow-auto">
            <table className="w-full text-left text-xs">
              <caption className="mb-2 text-left text-muted-foreground">
                <span>Bounded proxy observations only; baseline uses retained events</span>
              </caption>
              <thead>
                <tr>
                  <th className="p-2">
                    <span>Phase</span>
                  </th>
                  <th className="p-2">
                    <span>Observed</span>
                  </th>
                  <th className="p-2">
                    <span>Blocked</span>
                  </th>
                  <th className="p-2">
                    <span>Responses</span>
                  </th>
                  <th className="p-2">
                    <span>Errors</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["Baseline", experiment.baseline],
                    ["Block", experiment.blocked],
                    ["Recovery", experiment.recovery],
                  ] as const
                ).map(([label, evidence]) => (
                  <tr key={label}>
                    <th className="p-2">{label}</th>
                    <td className="p-2">{evidence.observed}</td>
                    <td className="p-2">{evidence.blocked}</td>
                    <td className="p-2">{evidence.responses}</td>
                    <td className="p-2">{evidence.errors}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex gap-2">
            {experiment.phase === "blocked" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!canChange || pending}
                onClick={() =>
                  void apply({ action: "stop-experiment", experimentId: experiment.id })
                }
              >
                <span>Restore access and collect recovery</span>
              </Button>
            ) : null}
            {experiment.phase !== "finished" ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={!canChange || pending}
                onClick={() =>
                  void apply({ action: "finish-experiment", experimentId: experiment.id })
                }
              >
                <span>Finish experiment</span>
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            <span>
              Ending this experiment removes only its own block. Other rules may still block this
              host.
            </span>
          </p>
        </article>
      ))}
    </section>
  );
}
