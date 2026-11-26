// The settings file as a code to copy and paste (More > Settings > Copy settings): `THS1.` + the file packed (gzip) in
// URL-safe base64, or `THS0.` + the file unpacked where the browser cannot pack. Pasting the file's own text works too.

export const DEVICE_KEYS = ['scanner.risk', 'scanner.maxAmount', 'studySource', 'npt_options_index', 'replayTestSide']; // choices kept on this phone, not the server

const b64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64 = (text) => {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};
const through = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

/** The file as a code. */
export async function encodeSettings(file) {
  const bytes = new TextEncoder().encode(JSON.stringify(file));
  if (typeof CompressionStream === 'function') {
    try {
      return `THS1.${b64(await through(bytes, new CompressionStream('gzip')))}`;
    } catch {
      /* fall through to the unpacked code */
    }
  }
  return `THS0.${b64(bytes)}`;
}

export class CodeError extends Error {}

/** A pasted code (or the file's own text) back to the file. Throws CodeError with a plain reason. */
export async function decodeSettings(text) {
  const t = String(text ?? '').replace(/\s+/g, '');
  if (!t) throw new CodeError('Paste the settings code first.');
  let json;
  try {
    if (t.startsWith('{')) json = String(text).trim();
    else if (t.startsWith('THS1.')) {
      if (typeof DecompressionStream !== 'function') throw new CodeError('This browser cannot open the code. Use the file instead.');
      json = new TextDecoder().decode(await through(unb64(t.slice(5)), new DecompressionStream('gzip')));
    } else if (t.startsWith('THS0.')) json = new TextDecoder().decode(unb64(t.slice(5)));
    else throw new CodeError('This is not a settings code. It starts with THS.');
    return JSON.parse(json);
  } catch (e) {
    if (e instanceof CodeError) throw e;
    throw new CodeError('The code is cut off or damaged. Copy the whole code again.');
  }
}

/** The phone's own choices (risk and amount in the scanner, the study data, the options index) for the file. */
export function readDevice(storage = globalThis.localStorage) {
  const out = {};
  try {
    for (const k of DEVICE_KEYS) {
      const v = storage?.getItem(k);
      if (v != null) out[k] = v;
    }
  } catch {
    /* storage unavailable */
  }
  return out;
}

/** Puts the phone choices of a file on this phone; anything not in the list is ignored. */
export function writeDevice(device, storage = globalThis.localStorage) {
  if (!device || typeof device !== 'object') return;
  try {
    for (const k of DEVICE_KEYS) {
      if (typeof device[k] === 'string' && device[k].length < 200) storage?.setItem(k, device[k]);
      else storage?.removeItem(k);
    }
  } catch {
    /* storage unavailable */
  }
}
