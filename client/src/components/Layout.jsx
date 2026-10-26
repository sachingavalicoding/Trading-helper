import { NavLink, Outlet } from 'react-router-dom';
import { LayoutDashboard, LineChart, Briefcase, ListOrdered, UserRound, Radar, Sun, Moon } from 'lucide-react';
import { IndexStrip } from './IndexStrip.jsx';
import { MarketStatus } from './MarketStatus.jsx';
import { useTheme } from '../context/ThemeContext.jsx';
import { Disclaimer } from './ui.jsx';

const NAV = [
  { to: '/', label: 'Watchlist', icon: LineChart, end: true },
  { to: '/scanner', label: 'Scanner', icon: Radar },
  { to: '/positions', label: 'Positions', icon: Briefcase },
  { to: '/orders', label: 'Orders', icon: ListOrdered },
  { to: '/dashboard', label: 'P&L', icon: LayoutDashboard },
  { to: '/account', label: 'Account', icon: UserRound },
];

function Brand({ className = '', small = false }) {
  return (
    <div className={`flex items-center gap-2.5 whitespace-nowrap ${className}`}>
      <img src="/icon.svg" alt="" className={small ? 'h-7 w-7' : 'h-9 w-9'} />
      <div className="leading-tight">
        <div className={`font-bold tracking-tight ${small ? 'text-[15px]' : 'text-base'}`}>Nifty Paper</div>
        {!small && <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted">Practice desk</div>}
      </div>
    </div>
  );
}

export function Layout() {
  const { theme, toggle } = useTheme();
  return (
    <div className="min-h-dvh md:flex">
      {/* Desktop side rail */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-line bg-surface/80 p-4 backdrop-blur md:flex">
        <Brand className="mb-8 px-2 pt-1" />
        <nav className="flex flex-col gap-1">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${isActive ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-fg'}`}
            >
              <Icon className="h-[18px] w-[18px]" strokeWidth={2} /> {label}
            </NavLink>
          ))}
        </nav>
        <Disclaimer className="mt-auto" />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
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
          <Outlet />
        </main>

        {/* Mobile bottom tab bar */}
        <nav className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/90 backdrop-blur-xl md:hidden">
          <div className="grid grid-cols-6">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) => `relative flex flex-col items-center gap-0.5 py-2.5 text-[10px] font-semibold transition-colors ${isActive ? 'text-accent' : 'text-muted'}`}
              >
                {({ isActive }) => (
                  <>
                    {isActive && <span className="absolute top-0 h-0.5 w-8 rounded-full bg-accent" />}
                    <Icon className="h-5 w-5" strokeWidth={isActive ? 2.4 : 1.9} />
                    {label}
                  </>
                )}
              </NavLink>
            ))}
          </div>
        </nav>
      </div>
    </div>
  );
}
