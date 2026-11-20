// Telegram Mini App authentication: validates the signed `initData` string
// the Telegram client hands to the web app. Spec:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

export interface TgUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

const enc = new TextEncoder();

async function hmac(key: BufferSource, message: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(message));
}

const toHex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

function dataCheckString(params: URLSearchParams): string {
  const entries: [string, string][] = [];
  for (const [k, v] of params) if (k !== 'hash') entries.push([k, v]);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return entries.map(([k, v]) => `${k}=${v}`).join('\n');
}

async function computeHash(params: URLSearchParams, botToken: string): Promise<string> {
  const secret = await hmac(enc.encode('WebAppData'), botToken);
  return toHex(await hmac(secret, dataCheckString(params)));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Returns the Telegram user, or null if the data is forged, malformed or too old. */
export async function validateInitData(
  initData: string,
  botToken: string,
  nowSec: number,
  maxAgeSec = 24 * 3600,
): Promise<TgUser | null> {
  if (!initData || initData.length > 4096 || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  if (!safeEqual(hash, await computeHash(params, botToken))) return null;

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || nowSec - authDate > maxAgeSec || authDate - nowSec > 300) return null;

  try {
    const user = JSON.parse(params.get('user') ?? '') as TgUser;
    return Number.isSafeInteger(user.id) && user.id > 0 ? user : null;
  } catch {
    return null;
  }
}

/** Builds a correctly signed initData string. For tests and the local dev server only. */
export async function signInitData(fields: Record<string, string>, botToken: string): Promise<string> {
  const params = new URLSearchParams(fields);
  params.set('hash', await computeHash(params, botToken));
  return params.toString();
}
