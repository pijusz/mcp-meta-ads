import { createHmac } from "node:crypto";
import { getEnv } from "@/config/env";
import { cacheGet, cacheSet, tokenKey } from "@/services/cache";

/**
 * Build the Authorization header for Meta Graph API requests.
 *
 * Auth model: a Business Manager System User access token in `META_ADS_ACCESS_TOKEN`.
 * Tokens are long-lived; expire only if revoked or the System User is removed.
 */
export function getAuthHeaders(): Record<string, string> {
  const env = getEnv();
  return {
    Authorization: `Bearer ${env.META_ADS_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  };
}

/**
 * If `META_ADS_APP_SECRET` is set, returns an `appsecret_proof` param
 * (HMAC-SHA256 of the access token, keyed with the app secret, hex-encoded).
 * Meta uses this to verify the request originated from a client that knows the secret.
 *
 * Memoized for the process lifetime, keyed by sha256(token). Token rotation
 * invalidates automatically because the key changes.
 *
 * Reference: https://developers.facebook.com/docs/graph-api/security
 */
export function getAppSecretProof(): string | null {
  const env = getEnv();
  if (!env.META_ADS_APP_SECRET) return null;
  const key = tokenKey(env.META_ADS_ACCESS_TOKEN, "appsecret_proof");
  const cached = cacheGet<string>(key);
  if (cached !== undefined) return cached;
  const proof = createHmac("sha256", env.META_ADS_APP_SECRET)
    .update(env.META_ADS_ACCESS_TOKEN)
    .digest("hex");
  cacheSet(key, proof, Number.POSITIVE_INFINITY);
  return proof;
}
