import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { YandexOAuthManager } from "../src/auth/oauth.js";
import type { AppConfig } from "../src/config.js";

const baseConfig: AppConfig = {
  httpTimeoutMs: 1_000,
  httpMaxRetries: 0,
  maxResultRows: 100,
  maxResultBytes: 100_000,
  transport: "http",
  httpHost: "127.0.0.1",
  httpPort: 3_000,
};

describe("YandexOAuthManager", () => {
  it("uses PKCE and stores profiles encrypted behind an internal bearer token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yandex-seo-oauth-"));
    const manager = new YandexOAuthManager({
      ...baseConfig,
      oauthClientId: "client-id",
      oauthRedirectUri: "https://mcp.example.com/oauth/callback",
      oauthStorageKey: "a-secure-test-key-with-at-least-32-characters",
      oauthStoragePath: join(directory, "profiles.enc"),
    });
    const authorization = manager.createAuthorization("alice");
    const url = new URL(authorization.authorizationUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const state = url.searchParams.get("state")!;
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const body = init?.body as URLSearchParams;
      if (body.get("grant_type") === "refresh_token") {
        return new Response(
          JSON.stringify({
            access_token: "refreshed-yandex-token",
            refresh_token: "new-refresh-token",
            expires_in: 3600,
          }),
          { status: 200 },
        );
      }
      expect(body.get("code_verifier")).toBeTruthy();
      return new Response(
        JSON.stringify({
          access_token: "yandex-access-token",
          refresh_token: "yandex-refresh-token",
          expires_in: -1,
        }),
        { status: 200 },
      );
    });

    const callback = await manager.exchangeCallback(
      state,
      "authorization-code",
      fetchMock as unknown as typeof fetch,
    );

    expect(callback.profile).toBe("alice");
    expect(
      (
        await manager.resolveSessionToken(
          callback.sessionToken,
          fetchMock as unknown as typeof fetch,
        )
      )?.accessToken,
    ).toBe("refreshed-yandex-token");
    expect(await manager.resolveSessionToken("wrong-token")).toBeUndefined();
    expect(await manager.listProfiles()).toEqual([expect.objectContaining({ profile: "alice" })]);
  });
});
