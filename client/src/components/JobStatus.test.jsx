import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { JobStatus, LoadState, stepCount, took } from './JobStatus.jsx';
import { dayProgress } from './Replay.jsx';

describe('JobStatus', () => {
  it('reads "x of y" and "(x/y)" from a step', () => {
    expect(stepCount('Month 3 of 12 (2026-01)')).toEqual({ done: 3, total: 12 });
    expect(stepCount('Replaying the scanner on TCS (7/50)')).toEqual({ done: 7, total: 50 });
    expect(stepCount('Reading the year files')).toBeNull();
  });

  it('says times in words', () => {
    expect(took(45)).toBe('45 s');
    expect(took(190)).toBe('3 min 10 s');
    expect(took(3900)).toBe('1 h 05 min');
  });

  it('shows the state, the count and a bar', () => {
    render(<JobStatus state="running" title="Year test" step="Month 2 of 4" done={2} total={4} unit="months" />);
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText(/2 of 4 months · 50%/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  });

  it('a failure shows the reason and Try again', () => {
    const retry = vi.fn();
    render(<LoadState error={new Error('Server down')} onRetry={retry} what="days" />);
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Server down')).toBeInTheDocument();
    screen.getByText('Try again').click();
    expect(retry).toHaveBeenCalled();
  });
});

describe('replay day progress', () => {
  it('is the share of 09:15-15:30 played and the real time left at the real speed', () => {
    const startMs = Date.UTC(2026, 10, 20, 3, 45);
    const endMs = startMs + 375 * 60000; // 6 h 15 min
    const p = dayProgress({ startMs, endMs, virtualNow: startMs + 375 * 30000, speed: 50, realSpeed: 25 });
    expect(Math.round(p.pct)).toBe(50);
    expect(Math.round(p.leftReal)).toBe(Math.round((375 * 30) / 25));
  });
});
