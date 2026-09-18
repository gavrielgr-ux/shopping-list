import { AUTH_SECRET, FIREBASE_API_KEY, ID_TOKEN_OVERRIDE } from "./constants.js";
import { HttpError, requestJson } from "./http.js";
import { clearIdentity, readState, saveIdentity } from "./state.js";

interface SignUpResponse {
  idToken: string;
  refreshToken: string;
  localId: string;
  expiresIn: string;
}

interface RefreshResponse {
  id_token: string;
  refresh_token: string;
  expires_in: string;
}

interface CachedToken {
  token: string;
  /** Epoch milliseconds after which the token must be replaced. */
  expiresAt: number;
}

/** Renew this long before actual expiry, so a token cannot lapse mid-request. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

let cached: CachedToken | null = null;
/** Single-flight guard: concurrent tool calls share one sign-in rather than racing. */
let inFlight: Promise<string> | null = null;

const secondsToExpiry = (value: string | undefined): number => {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 3600;
};

function explain(error: unknown): Error {
  if (!(error instanceof HttpError)) return error instanceof Error ? error : new Error(String(error));
  const reason = /"message"\s*:\s*"([^"]+)"/.exec(error.body)?.[1] ?? "";
  if (/OPERATION_NOT_ALLOWED|ADMIN_ONLY_OPERATION/.test(reason)) {
    return new Error(
      "Firebase rejected anonymous sign-in. Enable it in the Firebase console under " +
        "Authentication → Sign-in method → Anonymous (the web app needs it too), or set " +
        "SHOPPING_LIST_DB_SECRET to authenticate another way."
    );
  }
  if (/API key not valid|INVALID_API_KEY/i.test(reason) || error.status === 400) {
    return new Error(
      `Firebase rejected the API key (${reason || `HTTP ${error.status}`}). Check SHOPPING_LIST_API_KEY, ` +
        "or leave it unset to use the key published in the site's app.js."
    );
  }
  return new Error(`Firebase authentication failed (HTTP ${error.status}): ${reason || error.body.slice(0, 200)}`);
}

async function signInAnonymously(): Promise<CachedToken> {
  try {
    const result = await requestJson<SignUpResponse>(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(FIREBASE_API_KEY)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnSecureToken: true })
      }
    );
    await saveIdentity(result.refreshToken, result.localId);
    return {
      token: result.idToken,
      expiresAt: Date.now() + secondsToExpiry(result.expiresIn) * 1000
    };
  } catch (error) {
    throw explain(error);
  }
}

async function refresh(refreshToken: string): Promise<CachedToken | null> {
  try {
    const result = await requestJson<RefreshResponse>(
      `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(FIREBASE_API_KEY)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString()
      }
    );
    if (result.refresh_token) await saveIdentity(result.refresh_token, (await readState()).localId ?? "");
    return {
      token: result.id_token,
      expiresAt: Date.now() + secondsToExpiry(result.expires_in) * 1000
    };
  } catch (error) {
    // A revoked or expired refresh token is recoverable: drop it and sign in again.
    if (error instanceof HttpError && error.status >= 400 && error.status < 500) {
      await clearIdentity();
      return null;
    }
    throw explain(error);
  }
}

/**
 * Return a credential for the `auth` query parameter of the RTDB REST API.
 *
 * Precedence: an explicit database secret, then a caller-supplied ID token, then an anonymous
 * identity — the same one the web page uses, reused across restarts via the state file so the
 * Firebase project does not accumulate a new anonymous user on every launch.
 */
export async function getAuthToken(): Promise<string> {
  if (AUTH_SECRET) return AUTH_SECRET;
  if (ID_TOKEN_OVERRIDE) return ID_TOKEN_OVERRIDE;
  if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return cached.token;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const stored = (await readState()).refreshToken;
    const token = (stored ? await refresh(stored) : null) ?? (await signInAnonymously());
    cached = token;
    return token.token;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** Discard the cached token so the next call re-authenticates, used after a 401. */
export function invalidateToken(): void {
  cached = null;
}
