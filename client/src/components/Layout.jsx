import { NavLink, Outlet } from 'react-router-dom';
import { LayoutDashboard, LineChart, Briefcase, ListOrdered, UserRound, Sun, Moon } from 'lucide-react';
import { IndexStrip } from './IndexStrip.jsx';
import { MarketStatus } from './MarketStatus.jsx';
import { useTheme } from '../context/ThemeContext.jsx';
import { Disclaimer } from './ui.jsx';

const NAV = [
  { to: '/', label: 'Watchlist', icon: LineChart, end: true },
  { to: '/positions', label: 'Positions', icon: Briefcase },
  { to: '/orders', label: 'Orders', icon: ListOrdered },
  { to: '/dashboard', label: 'P&L', icon: LayoutDashboard },
  { to: '/account', label: 'Account', icon: UserRound },
];

export function Layout() {
  const { theme, toggle } = useTheme();
  return (
    <div className="min-h-dvh md:flex">
      {/* Desktop side rail */}
      <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-line bg-surface p-3 md:flex">
        <div className="mb-6 flex items-center gap-2 px-2 pt-1 text-lg font-bold">
          <img src="/icon.svg" alt="" className="h-7 w-7" /> Nifty Paper
        </div>
        <nav className="flex flex-col gap-1">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium ${isActive ? 'bg-surface-2 text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg'}`}
            >
              <Icon className="h-5 w-5" /> {label}
            </NavLink>
          ))}
        </nav>
        <Disclaimer className="mt-auto" />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-line bg-bg/90 backdrop-blur">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 pt-3">
            <div className="flex items-center gap-2 font-bold md:hidden">
              <img src="/icon.svg" alt="" className="h-6 w-6" /> Nifty Paper
            </div>
            <div className="ml-auto flex items-center gap-2">
              <MarketStatus />
              <button type="button" onClick={toggle} aria-label="Toggle theme" className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-fg">
                {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <div className="mx-auto max-w-5xl px-4 py-2">
            <IndexStrip />
          </div>
        </header>

        <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-3 pb-28 md:pb-10">
          <Outlet />
        </main>

        {/* Mobile bottom tab bar */}
        <nav className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur md:hidden">
          <div className="grid grid-cols-5">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) => `flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium ${isActive ? 'text-accent' : 'text-muted'}`}
              >
                <Icon className="h-5 w-5" />
                {label}
              </NavLink>
            ))}
          </div>
        </nav>
      </div>
    </div>
  );
}
