import type { CrawlRun, StorageData } from "./schema.js";

export interface CrawlRetentionPolicy {
  maxAgeDays: number;
  maxRunsPerTarget: number;
}

export interface CrawlCleanupCounts {
  runs: number;
  pages: number;
  issues: number;
  links: number;
  aggregates: number;
}

export interface CrawlRetentionPlan {
  retained: StorageData;
  deleted: CrawlCleanupCounts;
  deletedRunIds: string[];
  activeRunCount: number;
}

export function planCrawlHistoryCleanup(
  data: StorageData,
  policy: CrawlRetentionPolicy,
  now = new Date(),
): CrawlRetentionPlan {
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

  const retained: StorageData = {
    ...data,
    crawl: {
      runs: data.crawl.runs.filter((record) => retainedRunIds.has(record.id)),
      pages: data.crawl.pages.filter((record) => retainedRunIds.has(record.runId)),
      issues: data.crawl.issues.filter((record) => retainedRunIds.has(record.runId)),
      links: data.crawl.links.filter((record) => retainedRunIds.has(record.runId)),
      aggregates: data.crawl.aggregates.filter((record) => retainedRunIds.has(record.runId)),
    },
  };
  return {
    retained,
    deleted: {
      runs: data.crawl.runs.length - retained.crawl.runs.length,
      pages: data.crawl.pages.length - retained.crawl.pages.length,
      issues: data.crawl.issues.length - retained.crawl.issues.length,
      links: data.crawl.links.length - retained.crawl.links.length,
      aggregates: data.crawl.aggregates.length - retained.crawl.aggregates.length,
    },
    deletedRunIds: data.crawl.runs.filter(({ id }) => !retainedRunIds.has(id)).map(({ id }) => id),
    activeRunCount: data.crawl.runs.filter(({ status }) => status === "running").length,
  };
}

export function pruneCrawlHistory(
  data: StorageData,
  policy: CrawlRetentionPolicy,
  now = new Date(),
): StorageData {
  return planCrawlHistoryCleanup(data, policy, now).retained;
}
