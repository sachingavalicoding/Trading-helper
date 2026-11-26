import { describe, it, expect } from 'vitest';
import { CodeError, decodeSettings, encodeSettings, readDevice, writeDevice, DEVICE_KEYS } from './settingsCode.js';

const file = { format: 'trade-helper-settings', version: 1, options: { minScore: 80, combos: [{ id: 'a', name: 'Rupee ₹ combo', conds: ['rsiAbove50'] }] } };

const store = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
};

describe('settings code', () => {
  it('turns the file into a code and back, packed when the browser can', async () => {
    const code = await encodeSettings(file);
    expect(code).toMatch(/^THS[01]\.[A-Za-z0-9_-]+$/);
    expect(await decodeSettings(code)).toEqual(file);
    expect(await decodeSettings(`  ${code.slice(0, 20)}\n${code.slice(20)}  `)).toEqual(file); // line breaks a chat app may add
  });

  it('a big file packs to a much shorter code', async () => {
    const big = { ...file, options: { combos: Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, name: `Combination ${i}`, conds: ['rsiAbove50', 'aboveVwap', 'macdZero'], need: 2 })) } };
    const code = await encodeSettings(big);
    if (code.startsWith('THS1.')) expect(code.length).toBeLessThan(JSON.stringify(big).length / 2);
    expect(await decodeSettings(code)).toEqual(big);
  });

  it('accepts the file text pasted as is', async () => {
    expect(await decodeSettings(JSON.stringify(file, null, 2))).toEqual(file);
  });

  it('refuses empty, foreign and cut codes with a plain reason', async () => {
    const code = await encodeSettings(file);
    await expect(decodeSettings('')).rejects.toThrow(/Paste/);
    await expect(decodeSettings('hello')).rejects.toThrow(/not a settings code/);
    await expect(decodeSettings(code.slice(0, code.length - 15))).rejects.toBeInstanceOf(CodeError);
    await expect(decodeSettings('THS0.@@@')).rejects.toThrow(/cut off or damaged/);
  });

  it('copies only the known phone choices', () => {
    const a = store();
    a.setItem('scanner.risk', '0.5');
    a.setItem('studySource', 'year1');
    a.setItem('npt_token', 'secret');
    expect(readDevice(a)).toEqual({ 'scanner.risk': '0.5', studySource: 'year1' });
    const b = store();
    b.setItem('scanner.maxAmount', '9999');
    writeDevice({ 'scanner.risk': '0.5', npt_token: 'evil', studySource: 'year1' }, b);
    expect(b.getItem('scanner.risk')).toBe('0.5');
    expect(b.getItem('scanner.maxAmount')).toBe(null); // replaced fully
    expect(b.getItem('npt_token')).toBe(null);
    expect(DEVICE_KEYS).not.toContain('npt_token');
  });
});
