import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const calls = [];
vi.mock('../lib/api.js', () => ({
  api: vi.fn(async (path, opts = {}) => {
    calls.push([path, opts.method ?? 'GET', opts.body]);
    if (path === '/settings-transfer/preview') return { exportedAt: '2026-11-25T10:00:00Z', version: 1, total: 3, ignored: ['options.newThing'], sections: [{ key: 'options', name: 'Options bot', changes: [{ key: 'minScore', from: '70', to: '80' }], combos: { count: 2, on: 1, added: ['Breakout'], removed: ['Old one'], changed: [] } }, { key: 'rules', name: 'Stop, profit lock, close time', changes: [] }] };
    if (path === '/settings-transfer') return { ok: true };
    return { format: 'trade-helper-settings', version: 1, exportedAt: '2026-11-26T03:00:00Z', options: {} };
  }),
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

const { SettingsTransfer } = await import('./SettingsTransfer.jsx');
const { encodeSettings } = await import('../lib/settingsCode.js');

describe('Copy settings', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('pasting a code shows what will change, and replaces only after the confirm', async () => {
    render(<SettingsTransfer />);
    const code = await encodeSettings({ format: 'trade-helper-settings', version: 1, options: { minScore: 80 }, device: { 'scanner.risk': '1' } });
    fireEvent.change(screen.getByLabelText('Paste settings code'), { target: { value: code } });
    fireEvent.click(screen.getByText('Check the code'));
    await screen.findByText(/3 changes/);
    expect(screen.getByText('Added: Breakout')).toBeInTheDocument();
    expect(screen.getByText('Removed: Old one')).toBeInTheDocument();
    expect(screen.getByText('minScore')).toBeInTheDocument();
    expect(screen.getByText(/Left out .*options.newThing/)).toBeInTheDocument();
    expect(screen.queryByText('Stop, profit lock, close time')).toBeNull(); // nothing changes there
    expect(calls.some(([p]) => p === '/settings-transfer')).toBe(false);
    fireEvent.click(screen.getByText('Replace my settings'));
    await waitFor(() => expect(calls.find(([p]) => p === '/settings-transfer')).toEqual(['/settings-transfer', 'PUT', { file: { format: 'trade-helper-settings', version: 1, options: { minScore: 80 }, device: { 'scanner.risk': '1' } }, confirm: true }]));
  });

  it('a bad code shows the reason and no confirm button', async () => {
    render(<SettingsTransfer />);
    fireEvent.change(screen.getByLabelText('Paste settings code'), { target: { value: 'hello there' } });
    fireEvent.click(screen.getByText('Check the code'));
    await screen.findByText(/not a settings code/);
    expect(screen.queryByText('Replace my settings')).toBeNull();
  });

  it('Copy code shows the code even when the clipboard is not allowed', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => { throw new Error('denied'); }) }, configurable: true });
    render(<SettingsTransfer />);
    fireEvent.click(screen.getByText('Copy code'));
    const box = await screen.findByLabelText('Settings code');
    expect(box.value).toMatch(/^THS[01]\./);
    expect(calls[0]).toEqual(['/settings-transfer/export', 'GET', undefined]);
  });
});
