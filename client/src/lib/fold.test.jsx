import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Fold } from '../components/ui.jsx';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

test('a section starts closed, opens on tap, and is remembered', () => {
  const view = render(<Fold id="t1" title="Limits" summary="stop ₹200">hidden text</Fold>);
  expect(screen.getByText('stop ₹200')).toBeInTheDocument();
  expect(screen.queryByText('hidden text')).toBeNull();
  const button = screen.getByRole('button', { name: /Limits/ });
  expect(button).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(button);
  expect(screen.getByText('hidden text')).toBeInTheDocument();
  expect(button).toHaveAttribute('aria-expanded', 'true');
  view.unmount();
  render(<Fold id="t1" title="Limits">hidden text</Fold>);
  expect(screen.getByText('hidden text')).toBeInTheDocument();
});

test('a section can start open, and a plain one has no card', () => {
  render(<Fold id="t2" title="Entry now" plain defaultOpen>idea one</Fold>);
  expect(screen.getByText('idea one')).toBeInTheDocument();
});

test('a broken storage does not stop it working', () => {
  const real = Storage.prototype.getItem;
  Storage.prototype.getItem = () => {
    throw new Error('blocked');
  };
  try {
    render(<Fold id="t3" title="Study" defaultOpen>body</Fold>);
    expect(screen.getByText('body')).toBeInTheDocument();
  } finally {
    Storage.prototype.getItem = real;
  }
});
