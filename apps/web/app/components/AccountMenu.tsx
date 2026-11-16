'use client';
import Link from 'next/link';
import { useRef } from 'react';
import { closeOnBackdrop } from './AddDialog.tsx';
import { Icon } from './icons.tsx';
import { THEMES, THEME_ICON, THEME_LABEL, useTheme, type Theme } from './ThemeToggle.tsx';

/**
 * The signed-in person's corner of the sidebar on one row: avatar, name with the role beneath it, and a settings button.
 * Signing out is in the settings dialog.
 * Both pop-ups are native modal dialogs, so the browser centres them, traps focus, closes on Escape and returns focus
 * to the button that opened them. Sign out stays a real form post after the confirmation.
 */
export function AccountMenu({ displayName, roleLabel, initials, csrf, initialTheme, hasPin }: {
  displayName: string; roleLabel: string; initials: string; csrf: string; initialTheme: Theme; hasPin: boolean;
}) {
  const settings = useRef<HTMLDialogElement>(null);
  const confirm = useRef<HTMLDialogElement>(null);
  const [theme, setTheme] = useTheme(initialTheme);
  const askSignOut = () => { settings.current?.close(); confirm.current?.showModal(); };
  return <div className="account">
    <div className="account-id">
      <span className="avatar" aria-hidden="true">{initials}</span>
      <span className="account-who"><span className="account-name">{displayName}</span><span className="account-role">{roleLabel}</span></span>
      <button type="button" className="icon-button" aria-label="User settings" title="User settings" aria-haspopup="dialog" onClick={() => settings.current?.showModal()}>
        <Icon name="gear" />
      </button>
    </div>
    {!hasPin && <p className="account-pin-note"><Link href="/account/pin">Set a PIN</Link> so TallyMed can lock when you step away.</p>}

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
        {hasPin && <li>
          {/* A real form post: it works without scripts. The page path rides along so unlocking returns here. */}
          <form method="post" action="/api/auth/lock" onSubmit={(e) => {
            (e.currentTarget.elements.namedItem('next') as HTMLInputElement).value = `${location.pathname}${location.search}`;
          }}>
            <input type="hidden" name="csrf" value={csrf} /><input type="hidden" name="next" value="/" />
            <button type="submit" className="settings-item">
              <Icon name="lock" />
              <span><strong>Lock now</strong><span className="muted">Hide this screen until you enter your PIN. You stay signed in.</span></span>
            </button>
          </form>
        </li>}
        <li>
          <Link href="/account/pin" className="settings-item" onClick={() => settings.current?.close()}>
            <Icon name="lock" />
            <span><strong>{hasPin ? 'Change PIN' : 'Set a PIN'}</strong><span className="muted">The six digits that unlock the screen.</span></span>
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
