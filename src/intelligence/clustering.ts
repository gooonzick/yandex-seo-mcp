export type SearchIntent =
  "informational" | "commercial" | "transactional" | "navigational" | "local" | "mixed";

export interface QuerySignal {
  query: string;
  url?: string;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number | null;
  demand: number;
}

export interface QueryCluster {
  id: string;
  label: string;
  intent: SearchIntent;
  primaryQuery: string;
  queries: QuerySignal[];
  tokens: string[];
  pages: Array<{
    url: string;
    queryCount: number;
    impressions: number;
    clicks: number;
  }>;
  metrics: {
    impressions: number;
    clicks: number;
    ctr: number;
    position: number | null;
    demand: number;
  };
}

const stopWords = new Set([
  "а",
  "без",
  "более",
  "бы",
  "был",
  "в",
  "во",
  "для",
  "до",
  "его",
  "ее",
  "и",
  "из",
  "или",
  "к",
  "как",
  "на",
  "не",
  "о",
  "от",
  "по",
  "при",
  "с",
  "со",
  "у",
  "что",
  "это",
  "the",
  "a",
  "an",
  "and",
  "for",
  "from",
  "in",
  "of",
  "on",
  "to",
  "with",
]);

function stemToken(token: string): string {
  const suffixes = [
    "иями",
    "ями",
    "ами",
    "ого",
    "ему",
    "ыми",
    "ий",
    "ый",
    "ой",
    "ая",
    "яя",
    "ое",
    "ее",
    "ов",
    "ев",
    "ам",
    "ям",
    "ах",
    "ях",
    "ы",
    "и",
    "а",
    "я",
    "у",
    "ю",
    "е",
    "s",
    "es",
    "ing",
  ];
  for (const suffix of suffixes) {
    if (token.length - suffix.length >= 4 && token.endsWith(suffix))
      return token.slice(0, -suffix.length);
  }
  return token;
}

export function normalizeQuery(value: string): string {
  return value
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function queryTokens(value: string): string[] {
  return [
    ...new Set(
      normalizeQuery(value)
        .split(" ")
        .filter((token) => token.length >= 2 && !stopWords.has(token))
        .map(stemToken),
    ),
  ];
}

function trigrams(value: string): Set<string> {
  const normalized = `  ${normalizeQuery(value)}  `;
  const result = new Set<string>();
  for (let index = 0; index <= normalized.length - 3; index += 1)
    result.add(normalized.slice(index, index + 3));
  return result;
}

function jaccard<T>(left: Set<T>, right: Set<T>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

export function querySimilarity(left: string, right: string): number {
  const tokenScore = jaccard(new Set(queryTokens(left)), new Set(queryTokens(right)));
  const trigramScore = jaccard(trigrams(left), trigrams(right));
  return Math.round((tokenScore * 0.75 + trigramScore * 0.25) * 10_000) / 10_000;
}

export function detectIntent(query: string): SearchIntent {
  const normalized = normalizeQuery(query);
  const patterns: Array<[Exclude<SearchIntent, "mixed">, RegExp]> = [
    [
      "transactional",
      /(?:^| )(?:купить|заказать|цена|стоимость|доставка|book|buy|order|price)(?: |$)/u,
    ],
    [
      "commercial",
      /(?:^| )(?:лучший|рейтинг|обзор|сравнение|отзывы|выбрать|best|review|compare)(?: |$)/u,
    ],
    [
      "informational",
      /(?:^| )(?:как|почему|зачем|инструкция|руководство|что такое|how|why|guide|what)(?: |$)/u,
    ],
    ["local", /(?:^| )(?:рядом|адрес|москва|спб|санкт петербург|near me|location|address)(?: |$)/u],
    ["navigational", /(?:^| )(?:вход|личный кабинет|официальный сайт|login|official site)(?: |$)/u],
  ];
  const matches = patterns
    .filter(([, pattern]) => pattern.test(normalized))
    .map(([intent]) => intent);
  if (matches.length === 0) return "mixed";
  return matches[0]!;
}

function clusterIntent(queries: QuerySignal[]): SearchIntent {
  const counts = new Map<SearchIntent, number>();
  for (const query of queries) {
    const intent = detectIntent(query.query);
    counts.set(intent, (counts.get(intent) ?? 0) + Math.max(1, query.impressions));
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? "mixed";
}

function clusterLabel(queries: QuerySignal[]): { label: string; tokens: string[] } {
  const weights = new Map<string, number>();
  for (const query of queries)
    for (const token of queryTokens(query.query))
      weights.set(token, (weights.get(token) ?? 0) + Math.max(1, query.impressions));
  const tokens = [...weights.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([token]) => token);
  return { label: tokens.slice(0, 4).join(" ") || queries[0]!.query, tokens };
}

export function clusterQueries(signals: QuerySignal[], threshold: number): QueryCluster[] {
  const parents = signals.map((_signal, index) => index);
  const find = (index: number): number => {
    let current = index;
    while (parents[current] !== current) {
      parents[current] = parents[parents[current]!]!;
      current = parents[current]!;
    }
    return current;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  for (let left = 0; left < signals.length; left += 1) {
    for (let right = left + 1; right < signals.length; right += 1) {
      const leftSignal = signals[left]!;
      const rightSignal = signals[right]!;
      const samePageBoost =
        leftSignal.url && rightSignal.url && leftSignal.url === rightSignal.url ? 0.08 : 0;
      if (querySimilarity(leftSignal.query, rightSignal.query) + samePageBoost >= threshold)
        union(left, right);
    }
  }
  const groups = new Map<number, QuerySignal[]>();
  for (let index = 0; index < signals.length; index += 1) {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(signals[index]!);
    groups.set(root, group);
  }
  return [...groups.values()]
    .map((queries, index): QueryCluster => {
      queries.sort((left, right) => right.impressions - left.impressions);
      const impressions = queries.reduce((sum, query) => sum + query.impressions, 0);
      const clicks = queries.reduce((sum, query) => sum + query.clicks, 0);
      const positioned = queries.filter((query) => query.position !== null);
      const positionWeight = positioned.reduce(
        (sum, query) => sum + Math.max(1, query.impressions),
        0,
      );
      const pages = new Map<string, { queryCount: number; impressions: number; clicks: number }>();
      for (const query of queries) {
        if (!query.url) continue;
        const current = pages.get(query.url) ?? { queryCount: 0, impressions: 0, clicks: 0 };
        current.queryCount += 1;
        current.impressions += query.impressions;
        current.clicks += query.clicks;
        pages.set(query.url, current);
      }
      const label = clusterLabel(queries);
      return {
        id: `cluster-${index + 1}`,
        label: label.label,
        intent: clusterIntent(queries),
        primaryQuery: queries[0]!.query,
        queries,
        tokens: label.tokens,
        pages: [...pages.entries()]
          .map(([url, metrics]) => ({ url, ...metrics }))
          .sort((left, right) => right.impressions - left.impressions),
        metrics: {
          impressions,
          clicks,
          ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
          position:
            positionWeight > 0
              ? positioned.reduce(
                  (sum, query) => sum + query.position! * Math.max(1, query.impressions),
                  0,
                ) / positionWeight
              : null,
          demand: queries.reduce((sum, query) => sum + query.demand, 0),
        },
      };
    })
    .sort((left, right) => right.metrics.impressions - left.metrics.impressions);
}
