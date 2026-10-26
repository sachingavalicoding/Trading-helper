import { useEffect, useRef, useState } from 'react';

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
export function Segmented({ options, value, onChange, className = '', size = 'md' }) {
  const pad = size === 'sm' ? 'px-3 py-1 text-xs' : 'px-4 py-2 text-sm';
  return (
    <div role="tablist" className={`inline-flex rounded-xl border border-line bg-surface-2 p-1 ${className}`}>
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
    muted: 'bg-surface-2 text-muted',
  };
  return <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${tones[tone]} ${className}`}>{children}</span>;
}

export function Disclaimer({ className = '' }) {
  return <p className={`text-center text-[11px] text-muted ${className}`}>Paper trading for learning. Not investment advice.</p>;
}
