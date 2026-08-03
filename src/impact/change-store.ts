import { randomUUID } from "node:crypto";
import { YandexApiError } from "../shared/errors.js";
import { createPaginationScope, paginateByKey, type CursorPage } from "../shared/pagination.js";
import { DEFAULT_SECRET_QUERY_KEYS, sanitizeStoredUrl } from "../shared/stored-url.js";
import { StorageFile } from "../storage/file-store.js";
import type { SeoChange, SeoChangeType } from "../storage/schema.js";

export interface RecordSeoChangeInput {
  target: string;
  timestamp: string;
  type: SeoChangeType;
  urlScope: string[];
  description: string;
  externalReference: string;
}

export interface ListSeoChangesOptions {
  target?: string | undefined;
  type?: SeoChangeType | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  cursor?: string | undefined;
  limit: number;
}

function normalizeDate(value: string, name: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp))
    throw new YandexApiError("VALIDATION", `${name} must be an ISO date`);
  return new Date(timestamp).toISOString();
}

function sameChange(left: SeoChange, right: SeoChange): boolean {
  return (
    left.target === right.target &&
    left.timestamp === right.timestamp &&
    left.type === right.type &&
    JSON.stringify(left.urlScope) === JSON.stringify(right.urlScope) &&
    left.description === right.description &&
    left.externalReference === right.externalReference
  );
}

export class SeoChangeStore {
  private readonly storage: StorageFile;

  public constructor(
    filePath: string,
    private readonly queryParameterDenylist: readonly string[] = DEFAULT_SECRET_QUERY_KEYS,
  ) {
    this.storage = new StorageFile(filePath);
  }

  public async record(
    input: RecordSeoChangeInput,
  ): Promise<{ change: SeoChange; created: boolean }> {
    const target = sanitizeStoredUrl(input.target, this.queryParameterDenylist);
    const targetOrigin = new URL(target).origin;
    const urlScope = [
      ...new Set(input.urlScope.map((url) => sanitizeStoredUrl(url, this.queryParameterDenylist))),
    ].sort();
    if (urlScope.some((url) => new URL(url).origin !== targetOrigin))
      throw new YandexApiError("VALIDATION", "urlScope entries must use the target origin");
    const candidate: SeoChange = {
      id: randomUUID(),
      target,
      timestamp: normalizeDate(input.timestamp, "timestamp"),
      type: input.type,
      urlScope,
      description: input.description.trim(),
      externalReference: input.externalReference.trim(),
    };
    let result: { change: SeoChange; created: boolean } | undefined;
    await this.storage.update((data) => {
      const existing = data.seoChanges.find(
        (change) =>
          change.target === candidate.target &&
          change.externalReference === candidate.externalReference,
      );
      if (existing) {
        if (!sameChange(existing, candidate))
          throw new YandexApiError(
            "VALIDATION",
            "externalReference already identifies a different change for this target",
          );
        result = { change: structuredClone(existing), created: false };
        return data;
      }
      data.seoChanges.push(candidate);
      result = { change: structuredClone(candidate), created: true };
      return data;
    });
    return result!;
  }

  public async list(options: ListSeoChangesOptions): Promise<CursorPage<SeoChange>> {
    const data = await this.storage.read();
    const target = options.target
      ? sanitizeStoredUrl(options.target, this.queryParameterDenylist)
      : undefined;
    const dateFrom = options.dateFrom ? normalizeDate(options.dateFrom, "dateFrom") : undefined;
    const dateTo = options.dateTo ? normalizeDate(options.dateTo, "dateTo") : undefined;
    if (dateFrom && dateTo && dateFrom > dateTo)
      throw new YandexApiError("VALIDATION", "dateFrom must not be later than dateTo");
    const changes = data.seoChanges.filter(
      (change) =>
        (!target || change.target === target) &&
        (!options.type || change.type === options.type) &&
        (!dateFrom || change.timestamp >= dateFrom) &&
        (!dateTo || change.timestamp <= dateTo),
    );
    return paginateByKey(changes, {
      scope: createPaginationScope("seo-changes", { target, type: options.type, dateFrom, dateTo }),
      cursor: options.cursor,
      limit: options.limit,
      order: "desc",
      getKey: (change) => `${change.timestamp}\0${change.id}`,
    });
  }

  public async get(changeId: string): Promise<SeoChange | undefined> {
    const data = await this.storage.read();
    const change = data.seoChanges.find(({ id }) => id === changeId);
    return change ? structuredClone(change) : undefined;
  }
}
