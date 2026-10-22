import type { ReactNode } from 'react';

/**
 * A command or code sample. Long lines scroll sideways inside the block
 * (app/globals.css), so the block is focusable and named: a keyboard user can
 * tab to it and scroll it with the arrow keys, and a screen reader announces
 * what it holds (WCAG 2.1.1; axe's scrollable-region-focusable).
 */
export function CodeBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <pre tabIndex={0} role="region" aria-label={label}>
      <code>{children}</code>
    </pre>
  );
}
