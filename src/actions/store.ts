import { randomUUID } from "node:crypto";
import { telemetry } from "../shared/telemetry.js";
import { StorageFile } from "../storage/file-store.js";
import { ACTION_FINGERPRINT_VERSION, type ActionItem } from "./model.js";
import type { NormalizedActionBatch } from "./normalizers.js";

export interface ActionSyncResult {
  created: number;
  updated: number;
  unchanged: number;
  reopened: number;
  resolved: number;
  actions: ActionItem[];
}

function sameEvidence(left: ActionItem["evidence"][number], right: ActionItem["evidence"][number]) {
  return (
    left.sourceTool === right.sourceTool &&
    left.sourceResult.type === right.sourceResult.type &&
    left.sourceResult.id === right.sourceResult.id &&
    left.signal === right.signal
  );
}

export class ActionStore {
  private readonly storage: StorageFile;

  public constructor(filePath: string) {
    this.storage = new StorageFile(filePath);
  }

  public async sync(batch: NormalizedActionBatch): Promise<ActionSyncResult> {
    const result: ActionSyncResult = {
      created: 0,
      updated: 0,
      unchanged: 0,
      reopened: 0,
      resolved: 0,
      actions: [],
    };
    const observed = new Set(batch.candidates.map(({ fingerprint }) => fingerprint));
    await this.storage.update((data) => {
      for (const candidate of batch.candidates) {
        const existing = data.actions.find(
          ({ fingerprint }) => fingerprint === candidate.fingerprint,
        );
        if (!existing) {
          const timestamp = candidate.evidence.observedAt;
          const created: ActionItem = {
            ...candidate,
            id: randomUUID(),
            fingerprintVersion: ACTION_FINGERPRINT_VERSION,
            status: "open",
            evidence: [candidate.evidence],
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          data.actions.push(created);
          result.created += 1;
          result.actions.push(structuredClone(created));
          continue;
        }
        const duplicate = existing.evidence.some((item) => sameEvidence(item, candidate.evidence));
        const reopened = existing.status === "resolved";
        if (duplicate && !reopened) {
          result.unchanged += 1;
          result.actions.push(structuredClone(existing));
          continue;
        }
        existing.severity = candidate.severity;
        existing.impact = candidate.impact;
        existing.confidence = candidate.confidence;
        existing.effort = candidate.effort;
        existing.title = candidate.title;
        existing.description = candidate.description;
        if (!duplicate) existing.evidence = [...existing.evidence, candidate.evidence].slice(-100);
        if (reopened) {
          existing.status = "open";
          result.reopened += 1;
        }
        existing.updatedAt =
          candidate.evidence.observedAt > existing.updatedAt
            ? candidate.evidence.observedAt
            : existing.updatedAt;
        result.updated += 1;
        result.actions.push(structuredClone(existing));
      }
      if (batch.sourceComplete) {
        for (const action of data.actions) {
          if (
            action.affectedScope.target !== batch.target ||
            action.evidence[0]?.sourceTool !== batch.sourceTool ||
            observed.has(action.fingerprint) ||
            action.status === "resolved" ||
            action.status === "ignored"
          )
            continue;
          action.status = "resolved";
          const resolvedAt = new Date().toISOString();
          action.updatedAt = resolvedAt > action.updatedAt ? resolvedAt : action.updatedAt;
          result.resolved += 1;
        }
      }
      return data;
    });
    telemetry.event("action_ingest_sync");
    for (let index = 0; index < result.created; index += 1)
      telemetry.event("action_ingest_created");
    for (let index = 0; index < result.resolved; index += 1)
      telemetry.event("action_ingest_resolved");
    return result;
  }

  public async all(): Promise<ActionItem[]> {
    return structuredClone((await this.storage.read()).actions);
  }
}
