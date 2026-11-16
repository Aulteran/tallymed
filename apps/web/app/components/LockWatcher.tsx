'use client';
import { useEffect, useRef, useState } from 'react';

const ACTIVITY_KEY = 'tallymed:activity';
const LOCK_KEY = 'tallymed:lock';
const HEARTBEAT_MS = 30_000;
const CHECK_MS = 5_000;
const WRITE_MS = 5_000;
const EVENTS = ['pointerdown', 'pointermove', 'keydown', 'scroll', 'touchstart', 'wheel'] as const;

const read = (key: string): number => {
  try { return Number(localStorage.getItem(key)) || 0; } catch { return 0; }
};
const write = (key: string, value: number) => {
  try { localStorage.setItem(key, String(value)); } catch { /* private mode or blocked storage: this tab still locks on its own timer */ }
};

/**
 * Locks the screen when the person steps away. Mounted only for an account that has a PIN, and renders nothing until it locks.
 *
 * The lock itself is the server's: this component only decides *when*. After `idleSeconds` without a pointer, key, scroll or touch event
 * (counted across every open tab through localStorage) it posts to /api/auth/lock and then goes to the PIN screen, which renders no page
 * data. While the post is in flight a full-screen cover hides the page, and the cover stays if the post fails, retrying, so a network
 * error never leaves the records readable. While the person is active it posts a heartbeat every 30 seconds, because reading a page makes
 * no request and the server would otherwise count the session as idle. Other tabs follow a lock through the storage event.
 * Signing in stays untouched: nothing here signs anyone out.
 */
export function LockWatcher({ csrf, idleSeconds }: { csrf: string; idleSeconds: number }) {
  const [covered, setCovered] = useState(false);
  const state = useRef({ activity: Date.now(), written: 0, beat: Date.now(), locking: false });

  useEffect(() => {
    const s = state.current;
    const toLockScreen = () => {
      const next = `${location.pathname}${location.search}`;
      location.assign(`/locked?next=${encodeURIComponent(next)}`);
    };
    const post = (path: string) => fetch(path, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: '{}',
    });
    const lock = async () => {
      if (s.locking) return;
      s.locking = true;
      setCovered(true);
      for (;;) {
        try {
          const res = await post('/api/auth/lock');
          if (res.ok || res.status === 423) { write(LOCK_KEY, Date.now()); toLockScreen(); return; }
          if (res.status === 401) { location.assign('/login'); return; }
        } catch { /* offline: keep the cover and try again */ }
        await new Promise((r) => setTimeout(r, 5000));
      }
    };
    const beat = async () => {
      s.beat = Date.now();
      try {
        const res = await post('/api/auth/heartbeat');
        if (res.status === 423) toLockScreen();
        else if (res.status === 401) location.assign('/login');
      } catch { /* the next activity tries again */ }
    };
    const idleFor = () => Date.now() - Math.max(s.activity, read(ACTIVITY_KEY));
    const touch = () => {
      const now = Date.now();
      s.activity = now;
      if (now - s.written > WRITE_MS) { s.written = now; write(ACTIVITY_KEY, now); }
      if (now - s.beat > HEARTBEAT_MS && !s.locking) void beat();
    };
    const check = () => { if (idleFor() >= idleSeconds * 1000) void lock(); };
    const onStorage = (e: StorageEvent) => { if (e.key === LOCK_KEY && e.newValue) toLockScreen(); };
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };

    write(ACTIVITY_KEY, s.activity);
    for (const name of EVENTS) window.addEventListener(name, touch, { passive: true });
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', check);
    const timer = window.setInterval(check, CHECK_MS);
    return () => {
      for (const name of EVENTS) window.removeEventListener(name, touch);
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', check);
      window.clearInterval(timer);
    };
  }, [csrf, idleSeconds]);

  return covered ? <div className="lock-cover" role="alert" aria-live="assertive"><p>Locking…</p></div> : null;
}
