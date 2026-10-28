'use client';

import { useEffect } from 'react';

/** The fragment the Cloud card's button and WAITLIST_HREF point at. */
export const WAITLIST_ID = 'waitlist';

/** Whether a location hash, or a link's href, targets the waitlist. */
export function targetsWaitlist(hashOrHref: string | null | undefined): boolean {
  return typeof hashOrHref === 'string' && hashOrHref.endsWith(`#${WAITLIST_ID}`);
}

/** Open the waitlist's <details> and put focus in its first field. */
function openWaitlist(): void {
  const details = document.querySelector<HTMLDetailsElement>(`#${WAITLIST_ID} details`);
  if (!details) return;
  details.open = true;
  details.querySelector<HTMLElement>('input, select, textarea')?.focus();
}

/**
 * `:target` cannot open a <details>, so this opens the waitlist when the page
 * loads at /pricing#waitlist, when the hash changes to it, and when a link to it
 * is followed. Next's <Link> changes the hash with pushState, which fires no
 * hashchange, so link clicks are watched too. Renders nothing.
 */
export function WaitlistOpen() {
  useEffect(() => {
    const onHash = () => {
      if (targetsWaitlist(location.hash)) openWaitlist();
    };
    const onClick = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.('a[href]');
      if (link && targetsWaitlist(link.getAttribute('href'))) requestAnimationFrame(openWaitlist);
    };
    onHash();
    window.addEventListener('hashchange', onHash);
    document.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('hashchange', onHash);
      document.removeEventListener('click', onClick);
    };
  }, []);
  return null;
}
