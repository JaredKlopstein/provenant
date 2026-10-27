/**
 * Stand-in for next/font/google under vitest (aliased in vitest.config.ts). The
 * real loader is a build-time transform that cannot run in a test, so each font
 * here just echoes the CSS variable it was asked to define.
 */
interface FontOptions {
  readonly variable?: string;
}

const font = (opts: FontOptions = {}) => ({
  className: 'font-stub',
  variable: opts.variable ? `font-stub-${opts.variable.replace(/^--/, '')}` : '',
  style: { fontFamily: 'font-stub' },
});

export const IBM_Plex_Serif = font;
export const IBM_Plex_Sans = font;
export const IBM_Plex_Mono = font;
