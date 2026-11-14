import paths from '../../../../packages/brand/paths.json';

const { mark: m, wordmark: w } = paths;

/** The ledger and medical cross mark, inline so it follows the page theme. Geometry: packages/brand/paths.json. */
export function Mark({ onDark, className }: { onDark?: boolean; className?: string }) {
  return <svg viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false"><MarkShapes onDark={onDark} /></svg>;
}

function MarkShapes({ onDark }: { onDark?: boolean }) {
  const line = onDark ? '#FFFFFF' : 'var(--logo-line)';
  const paper = onDark ? 'none' : 'var(--logo-paper)';
  return <g fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth={4}>
    <path d={m.spine} fill="#14B8A6" stroke={line} />
    <path d={m.receipt} fill={paper} stroke={line} />
    <path d={m.lines} stroke={line} />
    <path d={m.cross} fill="#14B8A6" strokeWidth={0} />
  </g>;
}

/** Horizontal lockup: mark plus the TallyMed wordmark. */
export function Lockup({ onDark }: { onDark?: boolean }) {
  const gap = 14;
  return <svg viewBox={`0 0 ${64 + gap + w.width + 2} 64`} role="img" aria-label="TallyMed" className="lockup">
    <MarkShapes onDark={onDark} />
    <g transform={`translate(${64 + gap} ${32 + w.capHeight / 2 + 1})`}>
      <path d={w.tally} fill={onDark ? '#FFFFFF' : 'var(--logo-line)'} />
      <path d={w.med} fill="#14B8A6" />
    </g>
  </svg>;
}
