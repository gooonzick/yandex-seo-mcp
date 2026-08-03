import type { CrawlRun, StorageData } from "./schema.js";

export interface CrawlRetentionPolicy {
  maxAgeDays: number;
  maxRunsPerTarget: number;
}

export function pruneCrawlHistory(
  data: StorageData,
  policy: CrawlRetentionPolicy,
  now = new Date(),
): StorageData {
  const cutoff = now.getTime() - policy.maxAgeDays * 24 * 60 * 60 * 1_000;
  const retainedRunIds = new Set<string>();
  const completedByTarget = new Map<string, CrawlRun[]>();

  for (const run of data.crawl.runs) {
    if (run.status === "running") {
      retainedRunIds.add(run.id);
      continue;
    }
    const timestamp = Date.parse(run.finishedAt ?? run.startedAt);
    if (timestamp < cutoff) continue;
    const runs = completedByTarget.get(run.target) ?? [];
    runs.push(run);
    completedByTarget.set(run.target, runs);
  }

  for (const runs of completedByTarget.values()) {
    runs
      .sort((left, right) =>
        (right.finishedAt ?? right.startedAt).localeCompare(left.finishedAt ?? left.startedAt),
      )
      .slice(0, policy.maxRunsPerTarget)
      .forEach((run) => retainedRunIds.add(run.id));
  }

  return {
    ...data,
    crawl: {
      runs: data.crawl.runs.filter((record) => retainedRunIds.has(record.id)),
      pages: data.crawl.pages.filter((record) => retainedRunIds.has(record.runId)),
      issues: data.crawl.issues.filter((record) => retainedRunIds.has(record.runId)),
      links: data.crawl.links.filter((record) => retainedRunIds.has(record.runId)),
      aggregates: data.crawl.aggregates.filter((record) => retainedRunIds.has(record.runId)),
    },
  };
}
