'use client';
import { useEffect, useId, useRef, type MouseEvent, type ReactNode } from 'react';
import { Icon, type IconName } from './icons.tsx';

/** Closes a modal dialog when the click lands on its backdrop (the dialog element itself), not on its content. */
export const closeOnBackdrop = (e: MouseEvent<HTMLDialogElement>) => { if (e.target === e.currentTarget) e.currentTarget.close(); };

/**
 * The "add" action of a list page: a button with a plus icon in the page header that opens the page's add form in a centred
 * modal dialog. The form itself is passed in as children and stays an ordinary server-rendered form post.
 *
 * The dialog is a native modal `<dialog>`: the browser centres it, keeps focus inside, closes it on Escape and returns focus to
 * the button. `open` is set by the page when the form came back with an error (or when the address carries `add=1`), so the
 * dialog reopens with the message and the typed values in view. The button is a GET form that adds `add=1`, so it still opens
 * the form without JavaScript; with JavaScript the click opens the dialog in place.
 */
export function AddDialog({ label, title = label, open = false, keep = {}, icon = 'plus', secondary = false, requiredNote = true, marker = '1', children }: {
  label: string; title?: string; open?: boolean;
  /** The `add` value the opening button carries. A page with two dialogs gives each its own, so only the one asked for opens without JavaScript. */
  marker?: string;
  /** Icon on the opening button (null for none), whether it is a secondary button, and whether the dialog shows the "* required" note. */
  icon?: IconName | null; secondary?: boolean; requiredNote?: boolean;
  /** Current query values (filters) to keep in the address when the button is used without JavaScript. */
  keep?: Record<string, string>;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const opener = useRef<HTMLButtonElement>(null);
  const show = () => {
    const d = dialog.current;
    if (!d) return;
    if (d.open) d.close(); // rendered open by the server: reopen it as a modal
    d.showModal();
    d.querySelector<HTMLElement>('.modal-body :is(input:not([type="hidden"]), select, textarea)')?.focus();
  };
  useEffect(() => { if (open) show(); }, [open]);
  const onClose = () => {
    // Opened by the address: drop the marker and the error code so a reload does not reopen the dialog.
    const url = new URL(window.location.href);
    if (url.searchParams.has('add') || url.searchParams.has('error') || url.searchParams.has('preview')) {
      url.searchParams.delete('add');
      url.searchParams.delete('error');
      url.searchParams.delete('preview');
      window.history.replaceState(window.history.state, '', url);
    }
    if (!dialog.current?.open && (!document.activeElement || document.activeElement === document.body)) opener.current?.focus();
  };
  return <>
    <form method="get" className="page-action">
      {Object.entries(keep).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <input type="hidden" name="add" value={marker} />
      <button ref={opener} type="submit" className={secondary ? 'secondary' : undefined} aria-haspopup="dialog" onClick={(e) => { e.preventDefault(); show(); }}>{icon && <Icon name={icon} />}{label}</button>
    </form>
    <dialog ref={dialog} className="modal form-modal" open={open} aria-labelledby={titleId} onClick={closeOnBackdrop} onClose={onClose}>
      <div className="modal-head">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-button" aria-label="Close" title="Close" onClick={() => dialog.current?.close()}><Icon name="close" /></button>
      </div>
      <div className="modal-body">
        {requiredNote && <p className="muted required-note"><span className="required-mark" aria-hidden="true">*</span> required</p>}
        {children}
      </div>
    </dialog>
  </>;
}
