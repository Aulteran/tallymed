'use client';
import { useEffect, useState } from 'react';

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** Cosmetic countdown from the seconds the server computed at render time. The server decides whether undo still works. */
export function UndoCountdown({ seconds }: { seconds: number }) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    const end = Date.now() + seconds * 1000;
    const t = setInterval(() => setLeft(Math.max(0, Math.ceil((end - Date.now()) / 1000))), 1000);
    return () => clearInterval(t);
  }, [seconds]);
  // Hidden from screen readers so the status region is not re-announced every second; the static sentence beside it carries the time.
  return <span aria-hidden="true" className="num">{left > 0 ? clock(left) : 'ended'}</span>;
}
