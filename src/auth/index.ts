import { createHmac } from "node:crypto";
import { getEnv } from "../config/env.js";

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
 * Reference: https://developers.facebook.com/docs/graph-api/security
 */
export function getAppSecretProof(): string | null {
  const env = getEnv();
  if (!env.META_ADS_APP_SECRET) return null;
  return createHmac("sha256", env.META_ADS_APP_SECRET)
    .update(env.META_ADS_ACCESS_TOKEN)
    .digest("hex");
}
