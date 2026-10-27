'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

export const NAV_LIST_ID = 'site-nav-list';

export type NavItem = {
  readonly href: string;
  readonly label: string;
  /** `action` items sit at the right of the bar; `cta` is the one styled as a button. */
  readonly kind?: 'action' | 'cta';
};

/** What a key press does to the menu: close it and return focus to the Menu button, or nothing. */
export function navKeyAction(key: string, open: boolean): { open: false; focusToggle: true } | null {
  return key === 'Escape' && open ? { open: false, focusToggle: true } : null;
}

/**
 * The header nav. Horizontal on wide screens. Under 640px app/globals.css hides
 * the list and shows the Menu button from first paint, so server and hydrated
 * HTML lay out the same and nothing shifts; `@media (scripting: none)` shows the
 * list instead, so every link stays reachable without JavaScript. data-open opens
 * the list as a panel below the header row.
 */
export function NavMenu({ items }: { items: readonly NavItem[] }) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      const action = navKeyAction(event.key, open);
      if (!action) return;
      setOpen(action.open);
      if (action.focusToggle) toggle.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <nav aria-label="Main" className="site-nav" data-open={open ? '' : undefined}>
      <button
        ref={toggle}
        type="button"
        className="nav-toggle"
        aria-expanded={open}
        aria-controls={NAV_LIST_ID}
        onClick={() => setOpen((o) => !o)}
      >
        Menu
      </button>
      <ul id={NAV_LIST_ID}>
        {items.map((item) => (
          <li key={item.href} className={item.kind ? `nav-${item.kind}` : undefined}>
            <Link href={item.href} onClick={() => setOpen(false)}>
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
