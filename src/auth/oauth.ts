import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AppConfig } from "../config.js";

interface PendingAuthorization {
  profile: string;
  verifier: string;
  expiresAt: number;
}

export interface OAuthProfile {
  profile: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  sessionTokenHash: string;
  createdAt: string;
  updatedAt: string;
}

interface StoredProfiles {
  version: 1;
  profiles: OAuthProfile[];
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

export class YandexOAuthManager {
  private readonly clientId: string;
  private readonly clientSecret: string | undefined;
  private readonly redirectUri: string;
  private readonly filePath: string;
  private readonly encryptionKey: Buffer;
  private readonly pending = new Map<string, PendingAuthorization>();

  public constructor(config: AppConfig) {
    if (!config.oauthClientId || !config.oauthRedirectUri || !config.oauthStorageKey) {
      throw new Error(
        "Yandex OAuth requires YANDEX_OAUTH_CLIENT_ID, YANDEX_OAUTH_REDIRECT_URI and YANDEX_OAUTH_STORAGE_KEY",
      );
    }
    this.clientId = config.oauthClientId;
    this.clientSecret = config.oauthClientSecret;
    this.redirectUri = config.oauthRedirectUri;
    this.filePath = resolve(config.oauthStoragePath ?? ".yandex-seo-oauth.enc");
    this.encryptionKey = createHash("sha256").update(config.oauthStorageKey).digest();
  }

  public createAuthorization(profile: string): { authorizationUrl: string; expiresAt: string } {
    const state = base64Url(randomBytes(32));
    const verifier = base64Url(randomBytes(48));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const expiresAt = Date.now() + 10 * 60 * 1_000;
    this.pending.set(state, { profile, verifier, expiresAt });
    this.prunePending();
    const url = new URL("https://oauth.yandex.ru/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return { authorizationUrl: url.href, expiresAt: new Date(expiresAt).toISOString() };
  }

  public async exchangeCallback(
    state: string,
    code: string,
    fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<{ profile: string; sessionToken: string }> {
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.expiresAt < Date.now()) {
      throw new Error("OAuth state is invalid or expired");
    }
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      code_verifier: pending.verifier,
    });
    if (this.clientSecret) body.set("client_secret", this.clientSecret);
    const response = await fetchImplementation("https://oauth.yandex.ru/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const token = (await response.json()) as TokenResponse;
    if (!response.ok || !token.access_token) {
      throw new Error(
        token.error_description ?? token.error ?? "Yandex OAuth token exchange failed",
      );
    }
    const sessionToken = base64Url(randomBytes(48));
    const now = new Date().toISOString();
    const stored = await this.read();
    const previous = stored.profiles.find((profile) => profile.profile === pending.profile);
    const profile: OAuthProfile = {
      profile: pending.profile,
      accessToken: token.access_token,
      ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
      ...(token.expires_in ? { expiresAt: Date.now() + token.expires_in * 1_000 } : {}),
      sessionTokenHash: this.hashSessionToken(sessionToken),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    stored.profiles = stored.profiles.filter((item) => item.profile !== pending.profile);
    stored.profiles.push(profile);
    await this.write(stored);
    return { profile: pending.profile, sessionToken };
  }

  public async resolveSessionToken(
    sessionToken: string,
    fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<OAuthProfile | undefined> {
    const expected = Buffer.from(this.hashSessionToken(sessionToken), "hex");
    const stored = await this.read();
    const profile = stored.profiles.find((item) => {
      const actual = Buffer.from(item.sessionTokenHash, "hex");
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    });
    if (
      !profile ||
      !profile.expiresAt ||
      profile.expiresAt > Date.now() + 60_000 ||
      !profile.refreshToken
    )
      return profile;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: profile.refreshToken,
      client_id: this.clientId,
    });
    if (this.clientSecret) body.set("client_secret", this.clientSecret);
    const response = await fetchImplementation("https://oauth.yandex.ru/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const token = (await response.json()) as TokenResponse;
    if (!response.ok || !token.access_token)
      throw new Error(token.error_description ?? token.error ?? "Yandex OAuth refresh failed");
    profile.accessToken = token.access_token;
    if (token.refresh_token) profile.refreshToken = token.refresh_token;
    if (token.expires_in) profile.expiresAt = Date.now() + token.expires_in * 1_000;
    profile.updatedAt = new Date().toISOString();
    await this.write(stored);
    return profile;
  }

  public async listProfiles(): Promise<
    Array<Omit<OAuthProfile, "accessToken" | "refreshToken" | "sessionTokenHash">>
  > {
    return (await this.read()).profiles.map((profile) => ({
      profile: profile.profile,
      ...(profile.expiresAt ? { expiresAt: profile.expiresAt } : {}),
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    }));
  }

  private hashSessionToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private prunePending(): void {
    const now = Date.now();
    for (const [state, pending] of this.pending)
      if (pending.expiresAt < now) this.pending.delete(state);
  }

  private async read(): Promise<StoredProfiles> {
    try {
      const encoded = await readFile(this.filePath);
      if (encoded.length < 29) throw new Error("Encrypted OAuth store is invalid");
      const iv = encoded.subarray(0, 12);
      const tag = encoded.subarray(12, 28);
      const ciphertext = encoded.subarray(28);
      const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const parsed = JSON.parse(plaintext.toString("utf8")) as StoredProfiles;
      return parsed.version === 1 && Array.isArray(parsed.profiles)
        ? parsed
        : { version: 1, profiles: [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, profiles: [] };
      throw error;
    }
  }

  private async write(data: StoredProfiles): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
    const encoded = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, encoded, { mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
