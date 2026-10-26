/**
 * A compact table that holds up on a phone: sticky header, right-aligned numbers, two-line cells.
 * columns: [{ key, header, align = 'left' | 'right', render(row) -> node, className }]
 * `footer` is an optional row of nodes aligned to the columns (totals).
 */
export function DataTable({ columns, rows, rowKey = (r) => r._id, onRowClick, footer, className = '' }) {
  const align = (c) => (c.align === 'right' ? 'text-right' : 'text-left');
  return (
    <div className={`max-h-[70vh] overflow-auto ${className}`}>
      <table className="w-full border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={`sticky top-0 z-10 border-b border-line bg-surface-2 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted first:rounded-tl-2xl last:rounded-tr-2xl ${align(c)}`}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={rowKey(r)}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              className={`${i % 2 ? 'bg-surface-2/40' : ''} ${onRowClick ? 'cursor-pointer hover:bg-surface-2' : ''}`}
            >
              {columns.map((c) => (
                <td key={c.key} className={`border-b border-line px-3 py-2.5 align-top ${align(c)} ${c.align === 'right' ? 'num' : ''} ${c.className || ''}`}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer && (
          <tfoot>
            <tr>
              {columns.map((c) => (
                <td key={c.key} className={`sticky bottom-0 bg-surface-2 px-3 py-2 text-xs font-semibold ${align(c)} ${c.align === 'right' ? 'num' : ''}`}>
                  {footer[c.key] ?? ''}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** Two lines in one cell: the value, and a muted detail under it. */
export function Stack({ top, sub, className = '' }) {
  return (
    <div className={className}>
      <div>{top}</div>
      {sub != null && sub !== '' && <div className="text-[11px] font-normal text-muted">{sub}</div>}
    </div>
  );
}
