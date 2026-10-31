import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, X } from 'lucide-react';

export function Skeleton({ className = '' }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

export function Card({ className = '', children, ...rest }) {
  return (
    <div className={`card-shadow rounded-2xl border border-line bg-surface ${className}`} {...rest}>
      {children}
    </div>
  );
}

/** Pill-style segmented control. options: [{ value, label }] */
export function Segmented({ options, value, onChange, className = '', size = 'md', cols = 0 }) {
  const pad = size === 'sm' ? 'px-3 py-1 text-xs' : 'px-4 py-2 text-sm';
  // cols: lay the choices out in a grid of that many columns, so they wrap onto rows and never run off the screen
  const layout = cols ? `grid gap-1 ${cols === 2 ? 'grid-cols-2' : 'grid-cols-3'}` : 'inline-flex';
  return (
    <div role="tablist" className={`${layout} rounded-xl border border-line bg-surface-2 p-1 ${className}`}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={`${pad} flex-1 rounded-lg font-semibold transition-colors ${value === o.value ? 'bg-accent text-on-accent shadow-sm' : 'text-muted hover:text-fg'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Wraps a value and flashes green/red when it changes. */
export function Flash({ value, dir, className = '', children }) {
  const [cls, setCls] = useState('');
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current !== undefined && value !== prev.current && dir) {
      setCls(dir === 'up' ? 'flash-up' : 'flash-down');
      const t = setTimeout(() => setCls(''), 700);
      prev.current = value;
      return () => clearTimeout(t);
    }
    prev.current = value;
    return undefined;
  }, [value, dir]);
  return <span className={`rounded px-1 -mx-1 ${cls} ${className}`}>{children}</span>;
}

export function EmptyState({ icon: Icon, title, children }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      {Icon && <Icon className="h-10 w-10 text-muted" strokeWidth={1.5} />}
      <p className="font-medium">{title}</p>
      {children && <div className="text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Badge({ tone = 'muted', children, className = '' }) {
  const tones = {
    up: 'bg-up-soft text-up',
    down: 'bg-down-soft text-down',
    warn: 'bg-warn/15 text-warn',
    accent: 'bg-accent-soft text-accent',
    hot: 'bg-accent2-soft text-accent2',
    muted: 'bg-surface-2 text-muted',
  };
  return <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${tones[tone]} ${className}`}>{children}</span>;
}

export function Disclaimer({ className = '' }) {
  return <p className={`text-center text-[11px] text-muted ${className}`}>Paper trading for learning. Not investment advice.</p>;
}

const FOLD_KEY = 'npt_fold_';

/** An open/closed choice that is remembered per section on this phone. Without storage (private mode) it just starts as `fallback`. */
export function useFold(id, fallback = false) {
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(FOLD_KEY + id);
      return v == null ? fallback : v === '1';
    } catch {
      return fallback;
    }
  });
  const set = (next) => {
    setOpen(next);
    try {
      localStorage.setItem(FOLD_KEY + id, next ? '1' : '0');
    } catch {
      /* the choice is simply not remembered */
    }
  };
  return [open, set];
}

/**
 * A section you can show or hide. The header always tells what is inside (`summary`), so a closed section still gives the picture.
 * `plain` drops the card and shows only a heading row, for lists of cards.
 */
export function Fold({ id, title, summary, hint, icon: Icon, badge, defaultOpen = false, plain = false, className = '', children }) {
  const [open, setOpen] = useFold(id, defaultOpen);
  const body = useId();
  const header = (
    <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={body} className={`flex w-full items-center gap-3 text-left ${plain ? 'py-1' : 'px-4 py-3.5'}`}>
      {Icon && !plain && (
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent2-soft text-accent2">
          <Icon className="h-[18px] w-[18px]" strokeWidth={2} />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className={plain ? 'text-sm font-semibold' : 'text-[15px] font-semibold'}>{title}</span>
          {badge}
        </span>
        {(summary || hint) && <span className={`block text-xs leading-snug text-muted ${open && !plain ? '' : 'line-clamp-2'}`}>{summary || hint}</span>}
      </span>
      <ChevronDown className={`h-5 w-5 shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
    </button>
  );
  if (plain) {
    return (
      <section className={`space-y-2 ${className}`}>
        {header}
        <div id={body} hidden={!open} className="space-y-2">
          {open && children}
        </div>
      </section>
    );
  }
  return (
    <Card className={className}>
      {header}
      <div id={body} hidden={!open} className="border-t border-line px-4 py-3">
        {open && children}
      </div>
    </Card>
  );
}

/** A square on the Account page that opens a popup. `hint` is one short line; the full picture is inside the popup. */
export function PopupTile({ icon: Icon, label, hint, onClick }) {
  return (
    <button type="button" onClick={onClick} aria-haspopup="dialog" className="card-shadow flex flex-col items-start gap-1 rounded-2xl border border-line bg-surface p-3 text-left transition-colors hover:border-accent2">
      <Icon className="h-5 w-5 text-accent2" />
      <span className="flex w-full items-center justify-between text-sm font-semibold">
        {label} <ChevronRight className="h-4 w-4 text-muted" />
      </span>
      <span className="text-[11px] text-muted">{hint}</span>
    </button>
  );
}

/** A popup that slides up from the bottom on a phone and sits in the middle on a wide screen. Escape or a tap outside closes it. */
export function Sheet({ title, subtitle, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="sheet-in pb-safe relative max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl border border-line bg-surface md:max-w-2xl md:rounded-2xl">
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-line md:hidden" />
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 bg-surface px-4 pb-2 pt-3">
          <div className="min-w-0">
            <div className="text-lg font-bold">{title}</div>
            {subtitle && <div className="text-xs leading-snug text-muted">{subtitle}</div>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="btn btn-ghost -mr-2 !p-2">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="px-4 pb-4">{children}</div>
      </div>
    </div>
  );
}


/**
 * One button that shows the current choice and opens a bottom sheet to change it. Fits any number of choices on a phone,
 * where a row of tabs would run off the edge. Each option is { value, label, hint, icon }.
 */
export function Picker({ title, options, value, onChange }) {
  const [open, setOpen] = useState(false);
  const cur = options.find((o) => o.value === value) || options[0];
  const Icon = cur.icon;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" className="card-shadow flex w-full items-center gap-3 rounded-2xl border border-line bg-surface px-3 py-2.5 text-left transition-colors hover:border-accent2">
        {Icon && (
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent2-soft text-accent2">
            <Icon className="h-[18px] w-[18px]" />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted">{title}</span>
          <span className="block truncate text-[15px] font-semibold">{cur.label}</span>
        </span>
        <span className="flex items-center gap-1 text-xs font-semibold text-accent">
          Change <ChevronDown className="h-4 w-4" />
        </span>
      </button>
      {open && (
        <Sheet title={title} onClose={() => setOpen(false)}>
          <ul className="space-y-1.5">
            {options.map((o) => {
              const OIcon = o.icon;
              const on = o.value === value;
              return (
                <li key={o.value}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(o.value);
                      setOpen(false);
                    }}
                    aria-current={on}
                    className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left ${on ? 'border-accent bg-accent-soft' : 'border-line bg-surface-2 hover:border-accent2'}`}
                  >
                    {OIcon && <OIcon className="h-5 w-5 shrink-0 text-accent2" />}
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold">{o.label}</span>
                      {o.hint && <span className="block text-[11px] leading-snug text-muted">{o.hint}</span>}
                    </span>
                    {on && <Check className="h-4 w-4 shrink-0 text-accent" />}
                  </button>
                </li>
              );
            })}
          </ul>
        </Sheet>
      )}
    </>
  );
}
