import { Suspense } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { LineChart, Briefcase, Menu, Sun, Moon, CandlestickChart, Blocks } from 'lucide-react';
import { IndexStrip } from './IndexStrip.jsx';
import { MarketStatus } from './MarketStatus.jsx';
import { useTheme } from '../context/ThemeContext.jsx';
import { Disclaimer, Skeleton } from './ui.jsx';
import { ReplayBanner } from './Replay.jsx';

// Five tabs. Each tab owns a group of addresses, so the tab stays lit on its sub-pages (for example Trades on P&L and Orders).
export const NAV = [
  { to: '/', label: 'Market', icon: LineChart, paths: ['/', '/scanner', '/news', '/stock/'], subs: [{ to: '/', label: 'Stocks' }, { to: '/scanner', label: 'Scanner' }, { to: '/news', label: 'News' }] },
  { to: '/options', label: 'Options', icon: CandlestickChart, paths: ['/options'] },
  { to: '/combos', label: 'Combos', icon: Blocks, paths: ['/combos'] },
  { to: '/positions', label: 'Trades', icon: Briefcase, paths: ['/positions', '/dashboard', '/orders', '/review'], subs: [{ to: '/positions', label: 'Shares' }, { to: '/dashboard', label: 'P&L' }, { to: '/orders', label: 'Orders' }, { to: '/review', label: 'Day review' }] },
  { to: '/account', label: 'More', icon: Menu, paths: ['/account', '/settings', '/research'] },
];

/** The tab a page belongs to. */
export function tabOf(pathname) {
  return NAV.find((n) => n.paths.some((p) => (p === '/' ? pathname === '/' : p.endsWith('/') ? pathname.startsWith(p) : pathname === p || pathname.startsWith(`${p}/`)))) ?? null;
}

/** The small tabs at the top of Market and Trades: each page of the group, one tap away. */
export function SubTabs({ tab, pathname }) {
  if (!tab?.subs) return null;
  return (
    <nav aria-label={`${tab.label} pages`} className="-mx-1 mb-3 flex gap-1 overflow-x-auto px-1">
      {tab.subs.map((s) => {
        const on = s.to === pathname;
        return (
          <Link key={s.to} to={s.to} aria-current={on ? 'page' : undefined} className={`shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors ${on ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'}`}>
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}

function Brand({ className = '', small = false }) {
  return (
    <div className={`flex items-center gap-2.5 whitespace-nowrap ${className}`}>
      <img src="/icon.svg" alt="" className={small ? 'h-7 w-7' : 'h-9 w-9'} />
      <div className="leading-tight">
        <div className={`font-bold tracking-tight ${small ? 'text-[15px]' : 'text-base'}`}>
          Nifty <span className="text-accent2">Paper</span>
        </div>
        {!small && <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted">Practice desk</div>}
      </div>
    </div>
  );
}

export function Layout() {
  const { theme, toggle } = useTheme();
  const { pathname } = useLocation();
  const current = tabOf(pathname);
  return (
    <div className="min-h-dvh md:flex">
      {/* Desktop side rail */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-line bg-surface/80 p-4 backdrop-blur md:flex">
        <Brand className="mb-8 px-2 pt-1" />
        <nav className="flex flex-col gap-1">
          {NAV.map(({ to, label, icon: Icon }) => {
            const isActive = current?.to === to;
            return (
              <Link
                key={to}
                to={to}
                aria-current={isActive ? 'page' : undefined}
                className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${isActive ? 'bg-accent-soft text-accent shadow-[inset_3px_0_0_var(--accent2)]' : 'text-muted hover:bg-surface-2 hover:text-fg'}`}
              >
                <Icon className="h-[18px] w-[18px]" strokeWidth={2} /> {label}
              </Link>
            );
          })}
        </nav>
        <Disclaimer className="mt-auto" />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <ReplayBanner />
        <header className="sticky top-0 z-30 border-b border-line bg-bg/80 backdrop-blur-xl">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 pt-3">
            <Brand className="md:hidden" small />
            <div className="ml-auto flex items-center gap-2">
              <MarketStatus />
              <button type="button" onClick={toggle} aria-label="Toggle theme" className="btn btn-ghost !p-2">
                {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <div className="mx-auto max-w-5xl px-4 py-2">
            <IndexStrip />
          </div>
        </header>

        <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-3 pb-28 md:pb-10">
          <SubTabs tab={current} pathname={pathname} />
          {/* a page still downloading shows a placeholder here only: the header and the tab bar stay put */}
          <Suspense fallback={<Skeleton className="h-64 w-full" />}>
            <div key={pathname} className="page-in">
              <Outlet />
            </div>
          </Suspense>
        </main>

        {/* Mobile bottom tab bar */}
        <nav className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/90 backdrop-blur-xl md:hidden">
          <div className="grid grid-cols-5">
            {NAV.map(({ to, label, icon: Icon }) => {
              const isActive = current?.to === to;
              return (
                <Link
                  key={to}
                  to={to}
                  aria-current={isActive ? 'page' : undefined}
                  className={`relative flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-semibold transition-colors ${isActive ? 'text-accent' : 'text-muted'}`}
                >
                  {isActive && <span className="absolute top-0 h-0.5 w-8 rounded-full bg-accent2" />}
                  <Icon className="h-5 w-5" strokeWidth={isActive ? 2.4 : 1.9} />
                  {label}
                </Link>
              );
            })}
          </div>
        </nav>
      </div>
    </div>
  );
}
