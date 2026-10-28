'use client';

import { useEffect } from 'react';

/** Whether an element's top edge is at or above the line it reveals at (the viewport's bottom tenth). */
export function isDue(top: number, viewportHeight: number): boolean {
  return top < viewportHeight * 0.9;
}

/**
 * Restrained scroll reveal. Once mounted it sets data-reveal-ready on <html>,
 * then marks each [data-reveal] element data-revealed as it scrolls into view.
 * app/globals.css hides unrevealed elements only under html[data-reveal-ready]
 * inside prefers-reduced-motion: no-preference, so without JavaScript, or with
 * reduced motion, everything is visible from first paint. Renders nothing.
 *
 * Anything at or above the reveal line is shown, not only what intersects: a
 * jump (an anchor link, End, a fast fling) can carry an element from below the
 * viewport to above it without it ever intersecting, and it must not stay hidden.
 */
export function Reveal() {
  useEffect(() => {
    const root = document.documentElement;
    const pending = new Set(document.querySelectorAll<HTMLElement>('[data-reveal]'));
    const show = (el: HTMLElement) => {
      el.setAttribute('data-revealed', '');
      pending.delete(el);
    };
    const sweep = () => {
      for (const el of pending) if (isDue(el.getBoundingClientRect().top, window.innerHeight)) show(el);
    };

    // Anything already on screen stays shown, so turning the effect on never hides what is being read.
    sweep();
    if (pending.size === 0 || typeof IntersectionObserver === 'undefined') {
      pending.forEach(show);
      return;
    }

    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        sweep();
        if (pending.size === 0) stop();
      });
    };
    const observer = new IntersectionObserver(sweep, { rootMargin: '0px 0px -10% 0px' });
    const stop = () => {
      observer.disconnect();
      window.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };

    pending.forEach((el) => observer.observe(el));
    window.addEventListener('scroll', onScroll, { passive: true });
    root.setAttribute('data-reveal-ready', '');
    return () => {
      stop();
      root.removeAttribute('data-reveal-ready');
      pending.forEach(show);
    };
  }, []);
  return null;
}
