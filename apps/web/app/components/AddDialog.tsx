'use client';
import { useEffect, useRef, type MouseEvent, type ReactNode } from 'react';
import { Icon } from './icons.tsx';

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
export function AddDialog({ label, title = label, open = false, keep = {}, children }: {
  label: string; title?: string; open?: boolean;
  /** Current query values (filters) to keep in the address when the button is used without JavaScript. */
  keep?: Record<string, string>;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
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
    if (url.searchParams.has('add') || url.searchParams.has('error')) {
      url.searchParams.delete('add');
      url.searchParams.delete('error');
      window.history.replaceState(window.history.state, '', url);
    }
    if (!dialog.current?.open && (!document.activeElement || document.activeElement === document.body)) opener.current?.focus();
  };
  return <>
    <form method="get" className="page-action">
      {Object.entries(keep).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <input type="hidden" name="add" value="1" />
      <button ref={opener} type="submit" aria-haspopup="dialog" onClick={(e) => { e.preventDefault(); show(); }}><Icon name="plus" />{label}</button>
    </form>
    <dialog ref={dialog} className="modal form-modal" open={open} aria-labelledby="add-dialog-title" onClick={closeOnBackdrop} onClose={onClose}>
      <div className="modal-head">
        <h2 id="add-dialog-title">{title}</h2>
        <button type="button" className="icon-button" aria-label="Close" title="Close" onClick={() => dialog.current?.close()}><Icon name="close" /></button>
      </div>
      <div className="modal-body">
        <p className="muted required-note"><span className="required-mark" aria-hidden="true">*</span> required</p>
        {children}
      </div>
    </dialog>
  </>;
}
