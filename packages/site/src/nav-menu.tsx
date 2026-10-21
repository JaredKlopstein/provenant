'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

export const NAV_LIST_ID = 'site-nav-list';

export type NavItem = { readonly href: string; readonly label: string };

/**
 * The header nav. Horizontal on wide screens; under 640px app/globals.css hides
 * the list behind the Menu button. data-ready is set after hydration, so without
 * JavaScript the list never hides and every link stays reachable.
 */
export function NavMenu({ items }: { items: readonly NavItem[] }) {
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => setReady(true), []);

  return (
    <nav
      aria-label="Main"
      className="site-nav"
      data-ready={ready ? '' : undefined}
      data-open={open ? '' : undefined}
    >
      <button
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
          <li key={item.href}>
            <Link href={item.href} onClick={() => setOpen(false)}>
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
