import paths from '../../../../packages/brand/paths.json';

const { mark: m, wordmark: w } = paths;

/**
 * The ledger and medical cross mark, drawn inline so it follows the theme. `onDark` forces the white outline used on navy.
 * Geometry comes from packages/brand/paths.json, the same source as the SVG files.
 */
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

function Word({ x, baseline, scale = 1, onDark }: { x: number; baseline: number; scale?: number; onDark?: boolean }) {
  return <g transform={`translate(${x} ${baseline}) scale(${scale})`}>
    <path d={w.tally} fill={onDark ? '#FFFFFF' : 'var(--logo-line)'} />
    <path d={w.med} fill="#14B8A6" />
  </g>;
}

/** Horizontal lockup: mark plus wordmark. */
export function Lockup({ onDark, title = 'TallyMed' }: { onDark?: boolean; title?: string }) {
  const gap = 14;
  return <svg viewBox={`0 0 ${64 + gap + w.width + 2} 64`} role="img" aria-label={title}>
    <MarkShapes onDark={onDark} />
    <Word x={64 + gap} baseline={32 + w.capHeight / 2 + 1} onDark={onDark} />
  </svg>;
}

/** Stacked lockup for sign-in and setup. */
export function StackedLockup({ title = 'TallyMed' }: { title?: string }) {
  const scale = 0.75;
  const width = Math.max(w.width * scale, 64) + 8;
  return <svg viewBox={`0 0 ${width} ${64 + 12 + (w.capHeight + w.descent) * scale + 2}`} role="img" aria-label={title}>
    <g transform={`translate(${(width - 64) / 2} 0)`}><MarkShapes /></g>
    <Word x={(width - w.width * scale) / 2} baseline={64 + 12 + w.capHeight * scale} scale={scale} />
  </svg>;
}
