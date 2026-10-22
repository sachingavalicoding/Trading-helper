import { readFile, writeFile } from 'node:fs/promises';

// Upstox OAuth: the login dialog redirects back with ?code=..., which is exchanged for an
// access token valid until about 03:30 IST the next day.
export function upstoxLoginUrl({ apiKey, redirectUri }) {
  const url = new URL('https://api.upstox.com/v2/login/authorization/dialog');
  url.search = new URLSearchParams({ response_type: 'code', client_id: apiKey, redirect_uri: redirectUri });
  return url.toString();
}

export async function exchangeUpstoxCode(code, { apiKey, apiSecret, redirectUri }) {
  const res = await fetch('https://api.upstox.com/v2/login/authorization/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ code, client_id: apiKey, client_secret: apiSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const reason = data?.errors?.[0]?.message || `HTTP ${res.status}`;
    throw new Error(`Upstox token exchange failed: ${reason}`);
  }
  return data.access_token;
}

/** Write or replace KEY=value in a .env file. */
export async function setEnvValue(file, key, value) {
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch {
    // new file
  }
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  text = re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
  await writeFile(file, text);
}
