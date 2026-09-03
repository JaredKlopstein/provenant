import { registerAnchorBackend, type AnchorBackend } from './types.js';

/**
 * The open-source default. Records that an anchor point was reached, but
 * produces NO external proof -- so it is worth exactly nothing to a third party,
 * and says so in its own description rather than letting an operator discover
 * that during an audit.
 *
 * It exists so the code path is identical in both builds: the OSS user runs the
 * same `anchor now` command, sees the same record shape, and gets an explicit
 * `is_external: false`. That makes the upgrade a configuration change rather
 * than a code change, and it makes the limitation legible instead of hidden.
 */
export const noopBackend: AnchorBackend = {
  name: 'noop',
  description:
    'Records an anchor point with NO external proof. Self-attested and worth nothing in a security review -- it proves only that this operator claims a head existed. Use a real timestamp authority for evidence.',
  isExternal: false,
  async anchor() {
    return { type: 'none' as const };
  },
};

registerAnchorBackend(noopBackend);
