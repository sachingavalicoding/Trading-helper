import { useStudySource } from '../../lib/studySource.js';
import { Segmented } from '../ui.jsx';

/** Data for the studies: Saved data, or the year files (1 or 2 years). Shown above a study's Run button. */
export function StudySource({ kind }) {
  const [v, set] = useStudySource();
  const value = v.source === 'year' ? `year${v.years}` : 'saved';
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted">Data</div>
      <Segmented className="w-full" size="sm" value={value} onChange={(x) => set(x === 'saved' ? { source: 'saved', years: 1 } : { source: 'year', years: x === 'year2' ? 2 : 1 })} options={[{ value: 'saved', label: 'Saved data' }, { value: 'year1', label: 'Year files: 1 yr' }, { value: 'year2', label: '2 yrs' }]} />
      {v.source === 'year' && (
        <p className="text-[11px] text-muted">
          Reads the year files from Research &gt; Saved data (download or import them first; if they are missing the study says data not found).
          {kind === 'shares' ? ' Shares use the last 3 months of the files: the scanner replay is slow.' : ' Option prices are ESTIMATED here; real ones exist for about 30 days only.'} A long run takes a while; it runs on the server.
        </p>
      )}
    </div>
  );
}
