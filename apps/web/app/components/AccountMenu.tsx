'use client';
import Link from 'next/link';
import { useRef, type MouseEvent } from 'react';
import { Icon } from './icons.tsx';
import { THEMES, THEME_ICON, THEME_LABEL, ThemeToggle, useTheme, type Theme } from './ThemeToggle.tsx';

/** Closes a modal dialog when the click lands on its backdrop (the dialog element itself), not on its content. */
const closeOnBackdrop = (e: MouseEvent<HTMLDialogElement>) => { if (e.target === e.currentTarget) e.currentTarget.close(); };

/**
 * The signed-in person's corner of the sidebar: who they are, a settings button, a sign-out button, and quick links.
 * Both pop-ups are native modal dialogs, so the browser centres them, traps focus, closes on Escape and returns focus
 * to the button that opened them. Sign out stays a real form post: without JavaScript the button signs out directly.
 */
export function AccountMenu({ displayName, role, initials, csrf, initialTheme }: { displayName: string; role: string; initials: string; csrf: string; initialTheme: Theme }) {
  const settings = useRef<HTMLDialogElement>(null);
  const confirm = useRef<HTMLDialogElement>(null);
  const [theme, setTheme] = useTheme(initialTheme);
  const askSignOut = () => { settings.current?.close(); confirm.current?.showModal(); };
  return <div className="account">
    <div className="account-id">
      <span className="avatar" aria-hidden="true">{initials}</span>
      <span className="account-who"><span className="account-name">{displayName}</span><span className="account-role">{role}</span></span>
      <button type="button" className="icon-button" aria-label="User settings" title="User settings" aria-haspopup="dialog" onClick={() => settings.current?.showModal()}>
        <Icon name="gear" />
      </button>
      <form method="post" action="/api/auth/logout">
        <input type="hidden" name="csrf" value={csrf} />
        <button type="submit" className="icon-button danger" aria-label="Sign out" title="Sign out" aria-haspopup="dialog" onClick={(e) => { e.preventDefault(); askSignOut(); }}>
          <Icon name="logout" />
        </button>
      </form>
    </div>
    <div className="account-actions">
      <ThemeToggle initial={initialTheme} />
      <Link href="/account/password" className="ghost-link"><Icon name="key" />Change password</Link>
    </div>

    <dialog ref={settings} className="modal" aria-labelledby="user-settings-title" onClick={closeOnBackdrop}>
      <div className="modal-head">
        <h2 id="user-settings-title">User settings</h2>
        <button type="button" className="icon-button" aria-label="Close" title="Close" onClick={() => settings.current?.close()}><Icon name="close" /></button>
      </div>
      <p className="muted">Signed in as {displayName}.</p>
      <ul className="settings-list">
        <li>
          <Link href="/account/password" className="settings-item" onClick={() => settings.current?.close()}>
            <Icon name="key" />
            <span><strong>Change password</strong><span className="muted">The password for your own account.</span></span>
          </Link>
        </li>
        <li>
          <div className="settings-item" role="group" aria-labelledby="user-settings-theme">
            <Icon name={THEME_ICON[theme]} />
            <span><strong id="user-settings-theme">Change theme</strong><span className="muted">Light or dark for the whole site, on this browser.</span></span>
            <span className="segmented">
              {THEMES.map((t) => <button key={t} type="button" aria-pressed={theme === t} onClick={() => setTheme(t)}><Icon name={THEME_ICON[t]} />{THEME_LABEL[t]}</button>)}
            </span>
          </div>
        </li>
        <li>
          <button type="button" className="settings-item danger" onClick={askSignOut}>
            <Icon name="logout" />
            <span><strong>Sign out</strong><span className="muted">End this session on this device.</span></span>
          </button>
        </li>
      </ul>
    </dialog>

    <dialog ref={confirm} className="modal narrow" role="alertdialog" aria-labelledby="sign-out-title" aria-describedby="sign-out-text" onClick={closeOnBackdrop}>
      <h2 id="sign-out-title">Sign out?</h2>
      <p id="sign-out-text">You will need to sign in again to see this household's records.</p>
      <form method="post" action="/api/auth/logout" className="modal-actions">
        <input type="hidden" name="csrf" value={csrf} />
        <button type="button" className="secondary" autoFocus onClick={() => confirm.current?.close()}>Cancel</button>
        <button type="submit" className="danger">Sign out</button>
      </form>
    </dialog>
  </div>;
}
