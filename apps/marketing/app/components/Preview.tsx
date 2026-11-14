'use client';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { screenSize, type ScreenWithSources } from '../../lib/screens';

type ViewId = ScreenWithSources['id'];
type Theme = 'light' | 'dark';

/** Real screenshots of the application on fabricated data, in tabs, with a light and dark choice. Only the visible image loads. */
export default function Preview({ screens }: { screens: ScreenWithSources[] }) {
  const [active, setActive] = useState<ViewId>('dashboard');
  const [theme, setTheme] = useState<Theme>('light');
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const base = useId();

  // Start in the visitor's own theme, as the rest of the site does.
  useEffect(() => {
    try { if (window.matchMedia('(prefers-color-scheme: dark)').matches) setTheme('dark'); } catch { /* keep light */ }
  }, []);

  function onKeyDown(event: KeyboardEvent, index: number) {
    const last = screens.length - 1;
    const next = { ArrowRight: index === last ? 0 : index + 1, ArrowLeft: index === 0 ? last : index - 1, Home: 0, End: last }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setActive(screens[next].id);
    refs.current[screens[next].id]?.focus();
  }

  return <div className="preview">
    <div className="tabbar">
      <div role="tablist" aria-label="Application screens" className="tabs">
        {screens.map((view, index) => <button
          key={view.id}
          ref={(el) => { refs.current[view.id] = el; }}
          role="tab"
          type="button"
          id={`${base}-tab-${view.id}`}
          aria-selected={active === view.id}
          aria-controls={`${base}-panel-${view.id}`}
          tabIndex={active === view.id ? 0 : -1}
          onClick={() => setActive(view.id)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >{view.label}</button>)}
      </div>
      <div className="themes" role="group" aria-label="Screenshot theme">
        {(['light', 'dark'] as const).map((t) => <button key={t} type="button" aria-pressed={theme === t} onClick={() => setTheme(t)}>{t === 'light' ? 'Light' : 'Dark'}</button>)}
      </div>
    </div>
    {screens.map((view) => <div
      key={view.id}
      role="tabpanel"
      id={`${base}-panel-${view.id}`}
      aria-labelledby={`${base}-tab-${view.id}`}
      hidden={active !== view.id}
      tabIndex={0}
      className="panel"
    >
      <img className="shot-img" src={view.src[theme]} alt={view.alt[theme]} width={screenSize.width} height={screenSize.height} loading="lazy" decoding="async" />
      <p className="shot-caption">{view.caption}</p>
    </div>)}
    <p className="preview-note">Screenshots of the running application. Every name and amount is fictional.</p>
  </div>;
}
