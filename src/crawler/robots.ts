import type { RobotsInfo } from "./types.js";

interface Group {
  agents: string[];
  rules: Array<{ allow: boolean; path: string }>;
  crawlDelayMs?: number;
}

export function parseRobots(text: string, robotsUrl: string, userAgent: string): RobotsInfo {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | undefined;
  let hasRules = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const directive = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (directive === "sitemap") {
      try {
        sitemaps.push(new URL(value, robotsUrl).href);
      } catch {
        // Ignore malformed Sitemap declarations.
      }
      continue;
    }
    if (directive === "user-agent") {
      if (!current || hasRules) {
        current = { agents: [], rules: [] };
        groups.push(current);
        hasRules = false;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (!current) continue;
    if (directive === "allow" || directive === "disallow") {
      hasRules = true;
      if (value) current.rules.push({ allow: directive === "allow", path: value });
    } else if (directive === "crawl-delay") {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelayMs = seconds * 1_000;
    }
  }
  const normalizedAgent = userAgent.toLowerCase();
  const matching = groups.filter((group) =>
    group.agents.some((agent) => agent === "*" || normalizedAgent.includes(agent)),
  );
  const specificity = Math.max(
    0,
    ...matching.flatMap((group) => group.agents.map((agent) => (agent === "*" ? 0 : agent.length))),
  );
  const selected = matching.filter((group) =>
    group.agents.some((agent) => (agent === "*" ? 0 : agent.length) === specificity),
  );
  return {
    url: robotsUrl,
    fetched: true,
    sitemaps: [...new Set(sitemaps)],
    rules: selected.flatMap((group) => group.rules),
    ...(selected.some((group) => group.crawlDelayMs !== undefined)
      ? {
          crawlDelayMs: Math.max(...selected.map((group) => group.crawlDelayMs ?? 0)),
        }
      : {}),
  };
}

function patternMatches(pathname: string, pattern: string): boolean {
  const anchored = pattern.endsWith("$");
  const raw = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = raw
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}${anchored ? "$" : ""}`).test(pathname);
}

export function isAllowedByRobots(url: URL, robots: RobotsInfo): boolean {
  const path = `${url.pathname}${url.search}`;
  const matches = robots.rules
    .filter((rule) => patternMatches(path, rule.path))
    .sort((left, right) => right.path.length - left.path.length);
  if (matches.length === 0) return true;
  const longest = matches[0]!.path.length;
  return matches.filter((rule) => rule.path.length === longest).some((rule) => rule.allow);
}
