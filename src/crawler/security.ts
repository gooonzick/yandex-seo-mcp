import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { HostResolver } from "./types.js";

function blockedIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const a = parts[0]!;
  const b = parts[1]!;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function blockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0]!;
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8")
  );
}

export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return !blockedIpv4(address);
  if (version === 6) return !blockedIpv6(address);
  return false;
}

export const defaultHostResolver: HostResolver = async (hostname) => {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((result) => result.address);
};

export async function assertSafePublicUrl(url: URL, resolver: HostResolver): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Crawler supports only http and https URLs");
  if (url.username || url.password) throw new Error("Crawler URLs must not contain credentials");
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost"))
    throw new Error("Crawler refuses local hostnames");
  const addresses = isIP(hostname) ? [hostname] : await resolver(hostname);
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address)))
    throw new Error("Crawler refuses private, reserved or unresolved network targets");
}
