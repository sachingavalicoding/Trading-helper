import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NAV, SubTabs, tabOf } from './Layout.jsx';

describe('bottom menu', () => {
  it('has five tabs, and every page lights exactly one of them', () => {
    expect(NAV.map((n) => n.label)).toEqual(['Market', 'Options', 'Combos', 'Trades', 'More']);
    const cases = { '/': 'Market', '/scanner': 'Market', '/news': 'Market', '/stock/INFY': 'Market', '/options': 'Options', '/combos': 'Combos', '/positions': 'Trades', '/dashboard': 'Trades', '/orders': 'Trades', '/review': 'Trades', '/account': 'More', '/settings': 'More', '/research': 'More' };
    for (const [path, label] of Object.entries(cases)) expect(tabOf(path)?.label, path).toBe(label);
  });

  it('shows the pages of Trades as small tabs, with the open one marked', () => {
    render(
      <MemoryRouter>
        <SubTabs tab={tabOf('/orders')} pathname="/orders" />
      </MemoryRouter>,
    );
    expect(screen.getByText('Orders').getAttribute('aria-current')).toBe('page');
    expect(screen.getByText('P&L').getAttribute('href')).toBe('/dashboard');
    expect(screen.getByText('Day review').getAttribute('aria-current')).toBeNull();
  });
});
