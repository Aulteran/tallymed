'use client';
import { useRef, type ReactNode } from 'react';
import { closeOnBackdrop } from './AddDialog.tsx';
import { Icon } from './icons.tsx';

/**
 * A button that opens a modal confirmation. The dialog holds an ordinary server-rendered form (passed as children), so confirming is
 * a normal POST. Several can sit on one page: each takes its own `id` for the title.
 */
export function ConfirmDialog({ id, label, title = label, children }: { id: string; label: string; title?: string; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = `${id}-title`;
  return <>
    <button type="button" className="secondary" aria-haspopup="dialog" onClick={() => {
      const d = dialog.current;
      if (!d) return;
      d.showModal();
      d.querySelector<HTMLElement>('.modal-body :is(input:not([type="hidden"]), select, textarea)')?.focus();
    }}>{label}</button>
    <dialog ref={dialog} id={id} className="modal confirm-modal" aria-labelledby={titleId} onClick={closeOnBackdrop}>
      <div className="modal-head">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-button" aria-label="Close" title="Close" onClick={() => dialog.current?.close()}><Icon name="close" /></button>
      </div>
      <div className="modal-body">{children}</div>
    </dialog>
  </>;
}
