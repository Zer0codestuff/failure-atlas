import type { ReactNode } from 'react';

/** Consistent heading for every workspace view. */
export function PanelHead({ title, note }: { title: string; note?: ReactNode }) {
  return (
    <header className="panel-head">
      <h2 className="panel-title">{title}</h2>
      {note && <p className="panel-note">{note}</p>}
    </header>
  );
}
