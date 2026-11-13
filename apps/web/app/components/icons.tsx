import type { ReactNode } from 'react';

/** Small line icons drawn for TallyMed (24x24 grid, 1.75 stroke). Decorative: always paired with a text label. */
const PATHS: Record<string, ReactNode> = {
  overview: <><rect x="3.5" y="3.5" width="7" height="8" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="5" rx="1.5" /><rect x="13.5" y="12.5" width="7" height="8" rx="1.5" /><rect x="3.5" y="15.5" width="7" height="5" rx="1.5" /></>,
  visits: <><rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4M12 13v4M10 15h4" /></>,
  bills: <><path d="M6 3.5h12v17l-2-1.6-2 1.6-2-1.6-2 1.6-2-1.6-2 1.6z" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
  payments: <><rect x="2.5" y="5.5" width="19" height="13" rx="2" /><path d="M2.5 10h19M6 15h4" /></>,
  plans: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  hsa: <><path d="M12 3l7.5 3v5.5c0 4.6-3.1 7.9-7.5 9.5-4.4-1.6-7.5-4.9-7.5-9.5V6z" /><path d="M12 9v6M9 12h6" /></>,
  documents: <><path d="M13.5 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z" /><path d="M13.5 3.5v5h5M9 13h6M9 16.5h6" /></>,
  proposals: <><path d="M4 5.5h16v11H9.5L5.5 20v-3.5H4z" /><path d="M9 11l2 2 4-4" /></>,
  family: <><circle cx="9" cy="8" r="3.25" /><path d="M3 19.5c.6-3.3 2.9-5 6-5s5.4 1.7 6 5" /><circle cx="17" cy="9" r="2.5" /><path d="M16.5 14.6c2.4.2 4 1.8 4.5 4.4" /></>,
  providers: <><path d="M4 20.5V6l8-2.5L20 6v14.5" /><path d="M2.5 20.5h19M12 8v5M9.5 10.5h5M10 20.5v-4h4v4" /></>,
  operators: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.7-3.7 3.4-5.5 7-5.5s6.3 1.8 7 5.5" /></>,
  assistant: <><path d="M12 3.5l1.8 4.7 4.7 1.8-4.7 1.8L12 16.5l-1.8-4.7L5.5 10l4.7-1.8z" /><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" /></>,
  empty: <><path d="M4 13.5l2.5-8h11l2.5 8v5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z" /><path d="M4 13.5h4.5l1 2.5h5l1-2.5H20" /></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3L7 7M17 17l1.7 1.7M5.3 18.7L7 17M17 7l1.7-1.7" /></>,
  moon: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />,
  auto: <><circle cx="12" cy="12" r="8.5" /><path d="M12 3.5v17" /><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" /></>,
};
export type IconName = keyof typeof PATHS;

export function Icon({ name }: { name: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{PATHS[name]}</svg>;
}
