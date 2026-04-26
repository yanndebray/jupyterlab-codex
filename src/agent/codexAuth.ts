// Browser-side auth handling for the "Sign in with ChatGPT" provider.
//
// The Codex CLI signs in via OAuth + PKCE against auth.openai.com and writes
// the resulting token bundle to ~/.codex/auth.json. Browsers can't run that
// CLI and can't reach the user's home dir, so we accept the same bundle two
// ways:
//
//   1. Import — paste the contents of ~/.codex/auth.json from a machine
//      where `codex login` has already run. Deterministic; works today.
//
//   2. Sign in — device-code flow against the proxy at codexProxyUrl. The
//      proxy hands back the resulting token bundle, which we persist to
//      localStorage. Tokens never leave the user's browser except in the
//      Authorization header forwarded to the proxy.

import { resolveProxyUrl } from './proxyUrl';

const STORAGE_KEY = 'jupyterlab-codex:auth';

export interface ICodexAuthBundle {
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

export interface ICodexAuthState {
  bundle: ICodexAuthBundle;
  /** When this bundle was stored locally (ISO 8601). */
  storedAt: string;
}

export function loadCodexAuth(): ICodexAuthState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ICodexAuthState;
    if (!parsed?.bundle) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCodexAuth(bundle: ICodexAuthBundle): ICodexAuthState {
  const state: ICodexAuthState = {
    bundle,
    storedAt: new Date().toISOString()
  };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  return state;
}

export function clearCodexAuth(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}

/**
 * Pull the bearer token the proxy should forward to OpenAI. We prefer the
 * OAuth access_token (paid-by-ChatGPT-sub path); the legacy OPENAI_API_KEY
 * field is only used as a fallback for users who edited the file manually.
 */
export function getBearerToken(state: ICodexAuthState | null): string | null {
  if (!state) return null;
  const t = state.bundle.tokens?.access_token;
  if (t) return t;
  const k = state.bundle.OPENAI_API_KEY;
  if (k) return k;
  return null;
}

export function describeAuth(state: ICodexAuthState | null): string {
  if (!state) return 'Not signed in';
  const account = state.bundle.tokens?.account_id;
  if (account) return `Signed in (account ${account.slice(0, 8)}…)`;
  const token = getBearerToken(state);
  if (token) return `Signed in (token ${token.slice(0, 6)}…${token.slice(-4)})`;
  return 'Bundle present but no token found';
}

export function parsePastedAuth(input: string): ICodexAuthBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error(
      "Couldn't parse that as JSON. Paste the full contents of " +
        '~/.codex/auth.json (including the outer braces).'
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Expected a JSON object.');
  }
  const bundle = parsed as ICodexAuthBundle;
  const hasOAuthToken = !!bundle.tokens?.access_token;
  const hasApiKey = !!bundle.OPENAI_API_KEY;
  if (!hasOAuthToken && !hasApiKey) {
    throw new Error(
      "That JSON doesn't contain tokens.access_token or OPENAI_API_KEY. " +
        'Run `codex login` first, then paste ~/.codex/auth.json again.'
    );
  }
  return bundle;
}

export interface IDeviceCodeStart {
  device_auth_id: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_at?: string;
}

export async function startDeviceLogin(
  proxyUrl: string
): Promise<IDeviceCodeStart> {
  const url = resolveProxyUrl(proxyUrl).replace(/\/$/, '') + '/device/start';
  const resp = await fetch(url, { method: 'POST' });
  const text = await resp.text();
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const errBody = JSON.parse(text) as { error?: string };
      if (errBody.error) msg = errBody.error;
    } catch {
      if (text) msg = text.slice(0, 200);
    }
    throw new Error(`Device login start failed: ${msg}`);
  }
  return JSON.parse(text) as IDeviceCodeStart;
}

export async function pollDeviceLogin(
  proxyUrl: string,
  start: IDeviceCodeStart,
  signal?: AbortSignal,
  maxWaitMs = 15 * 60 * 1000
): Promise<ICodexAuthState> {
  const url = resolveProxyUrl(proxyUrl).replace(/\/$/, '') + '/device/poll';
  const intervalMs = Math.max(1, start.interval) * 1000;
  const deadline = Date.now() + maxWaitMs;
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const t = window.setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        window.clearTimeout(t);
        reject(new Error('Sign-in cancelled.'));
      });
    });
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error('Sign-in cancelled.');
    }
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_auth_id: start.device_auth_id,
        user_code: start.user_code
      }),
      signal
    });
    const text = await resp.text();
    let payload: {
      status?: 'pending' | 'complete';
      bundle?: ICodexAuthBundle;
      error?: string;
    };
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(
        `Device-auth poll: unexpected response (${resp.status}): ${text.slice(0, 200)}`
      );
    }
    if (!resp.ok || payload.error) {
      throw new Error(payload.error ?? `Device-auth poll failed (${resp.status})`);
    }
    if (payload.status === 'complete' && payload.bundle) {
      return saveCodexAuth(payload.bundle);
    }
    await sleep(intervalMs);
  }
  throw new Error('Device login timed out after 15 minutes.');
}
