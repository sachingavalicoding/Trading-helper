import { useState } from 'react';
import { formatPnl, pnlClass } from '../../lib/format.js';
import { Badge, Card } from '../ui.jsx';
import { scoreVerdict } from '../../lib/scoreStudy.js';

const Row = ({ label, s, note }) => (
  <tr>
    <td className="py-1.5 pr-2">{label}{note && <span className="block text-[10px] text-muted">{note}</span>}</td>
    <td>{s?.trades ?? 0}</td>
    <td>{s?.winRate == null ? '–' : `${s.winRate}%`}</td>
    <td className={pnlClass(s?.avgNet)}>{s?.avgNet == null ? '–' : formatPnl(s.avgNet)}</td>
  </tr>
);

/**
 * The share score study: every idea the scanner could have entered on the study days (any score), split by what each part of the score
 * said, by score band, and a check of weights fitted on the older days against the newer ones. Nothing changes until you decide.
 */
export function ScoreStudy({ s }) {
  const [all, setAll] = useState(false);
  if (!s || !s.ideas) return null;
  const parts = all ? s.parts : s.parts.filter((p) => p.enough).slice(0, 8);
  return (
    <Card className="space-y-3 p-3">
      <div>
        <h3 className="text-sm font-semibold">Does the score pick winners?</h3>
        <p className="text-[11px] leading-snug text-muted">
          Every idea the scanner could have entered ({s.ideas} over {s.days} days, any score), traded with your stop and ladder. A higher score should mean a better average; if it does not, the minimum score is not helping.
        </p>
      </div>
      <p className="rounded-lg bg-surface-2 p-2 text-[11px] leading-snug">{scoreVerdict(s)}</p>
      <table className="num w-full text-xs">
        <thead className="text-[10px] text-muted"><tr><th className="text-left font-normal">Score now</th><th className="text-left font-normal">Ideas</th><th className="text-left font-normal">Win</th><th className="text-left font-normal">Avg net</th></tr></thead>
        <tbody className="divide-y divide-line">{s.bands.now.map((b) => <Row key={b.band} label={b.band} s={b} />)}</tbody>
      </table>
      <details>
        <summary className="cursor-pointer text-[11px] font-semibold text-accent">The same with the score before 9 Nov (fewer indicators)</summary>
        <table className="num mt-1 w-full text-xs">
          <tbody className="divide-y divide-line">{s.bands.before.map((b) => <Row key={b.band} label={b.band} s={b} />)}</tbody>
        </table>
      </details>
      <div className="space-y-1">
        <h4 className="text-xs font-semibold">Which indicators help</h4>
        <p className="text-[11px] leading-snug text-muted">For each part: ideas where it agreed against ideas where it did not. "Helps" means the agreeing ideas averaged more. Parts with under 15 ideas on a side are "too few".</p>
        <ul className="divide-y divide-line">
          {parts.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 py-1.5 text-xs">
              <span className="min-w-0">
                <b>{p.label}</b> <span className="text-muted">({p.weight} pts)</span>{' '}
                <Badge tone={p.verdict === 'helps' ? 'up' : p.verdict === 'too few' ? undefined : 'down'}>{p.verdict}</Badge>
                <span className="num block text-[11px] text-muted">agreed: {p.on.trades} · {p.on.winRate ?? '–'}% win · avg {formatPnl(p.on.avgNet)} | did not: {p.off.trades} · {p.off.winRate ?? '–'}% · avg {formatPnl(p.off.avgNet)}</span>
              </span>
              <span className={`num shrink-0 font-semibold ${pnlClass(p.lift)}`}>{p.lift == null ? '–' : formatPnl(p.lift)}</span>
            </li>
          ))}
        </ul>
        <button type="button" className="text-[11px] font-semibold text-accent" onClick={() => setAll(!all)}>{all ? 'Show the main ones' : `Show all ${s.parts.length} parts`}</button>
      </div>
      {s.check && (
        <div className="space-y-1">
          <h4 className="text-xs font-semibold">Checked on newer days (from {s.check.from})</h4>
          <p className="text-[11px] leading-snug text-muted">The best third of the {s.check.ideas} newer ideas as each scorer ranks them. The suggested weights were picked on the older days only, so this is a fair check.</p>
          <table className="num w-full text-xs">
            <tbody className="divide-y divide-line">
              <Row label="All newer ideas" s={s.check.all} />
              <Row label="Best third, score now" s={s.check.now} />
              <Row label="Best third, score before 9 Nov" s={s.check.before} />
              {s.check.suggested && <Row label="Best third, suggested weights" s={s.check.suggested} />}
            </tbody>
          </table>
        </div>
      )}
      {s.suggested && (
        <details>
          <summary className="cursor-pointer text-[11px] font-semibold text-accent">Suggested weights (from the {s.fitOn})</summary>
          <ul className="num mt-1 grid grid-cols-2 gap-x-3 text-[11px]">
            {Object.entries(s.suggested).filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).map(([id, w]) => (
              <li key={id} className="flex justify-between"><span>{s.parts.find((p) => p.id === id)?.label ?? id}</span><span>{w} <span className="text-muted">(now {s.weights[id]})</span></span></li>
            ))}
          </ul>
          <p className="mt-1 text-[10px] leading-snug text-muted">Not applied. Send this study to Claude to switch the scanner to them once a 10 to 15 day run agrees.</p>
        </details>
      )}
    </Card>
  );
}
