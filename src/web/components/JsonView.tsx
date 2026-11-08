import { useState } from 'react';

/** Raw JSON behind an intentional control, rendered as text (never HTML), with copy and download. */
export function JsonView({ value, label, filename }: { value: unknown; label: string; filename: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = open ? JSON.stringify(value, null, 2) : '';
  return (
    <div className="jsonview">
      <div className="row gap">
        <button className="btn ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? '[-] hide raw JSON' : '[+] show raw JSON'}</button>
        {open && (
          <>
            <button
              className="btn ghost"
              onClick={async () => {
                try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setCopied(false); }
              }}
            >
              {copied ? 'copied' : 'copy'}
            </button>
            <button className="btn ghost" onClick={() => download(filename, text)}>download</button>
          </>
        )}
      </div>
      {open && <pre className="json" aria-label={label}>{text}</pre>}
    </div>
  );
}

export function download(name: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
