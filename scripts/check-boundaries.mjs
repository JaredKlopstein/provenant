#!/usr/bin/env node
/**
 * Open-core boundary check.
 *
 * The business model rests on one structural property: a third party must be able
 * to verify a Provenant bundle using only MIT code, with no network access and no
 * code from the commercial package. If that property is ever compromised, the
 * product's credibility -- and therefore its revenue -- goes with it.
 *
 * This runs in CI and fails the build on violation. It is deliberately a dumb,
 * dependency-free source scan rather than a lint plugin, so it cannot be silenced
 * by an eslint-disable comment.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

/** pkg -> packages it is forbidden from importing. */
const FORBIDDEN = {
  core: ['@provenant/cloud'],
  // The verifier is the credibility anchor. It may not depend on cloud, and it may
  // not depend on core either: an "independent" verifier that shares its hashing
  // implementation with the thing it audits is not independent. The shared-vector
  // cross-check test (packages/verifier/test/cross-impl.test.ts) guards against the
  // two implementations drifting apart.
  verifier: ['@provenant/cloud', '@provenant/core'],
  cloud: [],
};

/** Modules that would let the verifier phone home. It must work fully offline. */
const OFFLINE_FORBIDDEN = [
  'node:http', 'node:https', 'node:net', 'node:tls', 'node:dgram',
  'undici', 'axios', 'node-fetch', 'got',
];

/**
 * Module-specifier extraction.
 *
 * Rewritten after an audit found ~12 bypasses of the original regex: `import{x}`
 * with no space, template-literal specifiers, concatenated specifiers,
 * `createRequire` bound to another name, deep relative escapes, absolute paths,
 * and `.cts`/`.cjs`/`.tsx` files. Rather than enumerate syntax, this now scans
 * for the FORBIDDEN PACKAGE NAMES themselves anywhere in the source, outside
 * comments and strings that are obviously prose.
 *
 * The trade-off is deliberate: a stricter, dumber check that occasionally needs
 * an explicit allow-comment beats a clever one that can be walked around. This
 * boundary is the product's credibility, so it should fail loudly and often
 * rather than quietly and never.
 */
const IMPORT_RE = /(?:^|[^.\w])(?:import|export)\s*[{*\s][^;]*?from\s*['"`]([^'"`]+)['"`]|(?:^|[^.\w])(?:import|require)\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;

/** Strip comments so prose about the boundary does not trip the scanner. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Only `src/` is scanned. The verifier's TEST suite is deliberately allowed to
 * import core -- packages/verifier/test/cross-impl.test.ts exists precisely to
 * assert the two independent implementations agree byte-for-byte. Runtime code
 * under src/ may never import it, which is what actually matters: a shipped
 * verifier that shares code with the system it audits is not independent.
 */
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    // `test` is skipped only at the package root, never at arbitrary depth --
    // a directory named `test` nested inside src/ was a bypass.
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|mts|cts|tsx|js|mjs|cjs|jsx)$/.test(full)) out.push(full);
  }
  return out;
}

const violations = [];

for (const [pkg, forbidden] of Object.entries(FORBIDDEN)) {
  // `bin/` ships too (it is listed in package.json "files"), so it is in scope.
  // `test/` is out of scope by design: verifier/test/cross-impl.test.ts must
  // import core to prove the two implementations agree.
  const files = [...walk(join(ROOT, 'packages', pkg, 'src')), ...walk(join(ROOT, 'packages', pkg, 'bin'))];

  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const src = stripComments(raw);
    const rel = relative(ROOT, file);

    // Catch the package name however it is written -- template literals,
    // concatenation, dynamic import, absolute path, deep relative escape.
    for (const bad of forbidden) {
      const shortName = bad.replace('@provenant/', '');
      if (src.includes(bad)) {
        violations.push(`${rel}: '${pkg}' must not reference '${bad}' (found anywhere in source)`);
      }
      // packages/core/... or /packages/core/dist/... in any string form
      const pathRe = new RegExp(`packages[\\/]${shortName}[\\/]`);
      if (pathRe.test(src)) {
        violations.push(`${rel}: '${pkg}' must not reference a path into 'packages/${shortName}/'`);
      }
    }
    /**
     * Catch the scope prefix on its own. `'@provenant/' + 'core'` splits the
     * package name across two literals and defeats any whole-name match, so for
     * a package that has ANY forbidden dependency the bare scope has no
     * legitimate use in shipped source: the only names it could form are its own
     * (which it would not import) or a forbidden one.
     */
    if (forbidden.length > 0) {
      for (const m of src.matchAll(/@provenant\//g)) {
        const tail = src.slice(m.index, m.index + 40);
        if (!tail.startsWith(`@provenant/${pkg}`)) {
          violations.push(
            `${rel}: '${pkg}' must not reference the '@provenant/' scope (found "${tail.split(/['"\`\s]/)[0]}"). ` +
              `Splitting a package name across string literals is not an escape hatch.`,
          );
          break;
        }
      }
    }

    if (pkg === 'verifier') {
      // Network reachable without any import on modern Node.
      if (/\bfetch\s*\(/.test(src)) violations.push(`${rel}: verifier must work fully offline; it calls fetch()`);
      for (const g of ['XMLHttpRequest', 'WebSocket', 'navigator.sendBeacon', 'EventSource']) {
        if (src.includes(g)) violations.push(`${rel}: verifier must work fully offline; it references ${g}`);
      }
    }
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2];
      if (!spec) continue;

      for (const bad of forbidden) {
        if (spec === bad || spec.startsWith(bad + '/')) {
          violations.push(`${rel}: '${pkg}' must not import '${spec}'`);
        }
      }
      // Relative escapes out of the package are the sneaky way to do the same thing.
      if (spec.startsWith('.') && /(^|\/)\.\.\/\.\.\/(cloud|core)\//.test(spec)) {
        const target = spec.includes('/cloud/') ? '@provenant/cloud' : '@provenant/core';
        if (forbidden.includes(target)) {
          violations.push(`${rel}: '${pkg}' must not reach into '${spec}' (relative escape)`);
        }
      }
      if (pkg === 'verifier' && OFFLINE_FORBIDDEN.includes(spec)) {
        violations.push(`${rel}: verifier must work fully offline; '${spec}' is a network module`);
      }
    }
  }
}

/**
 * Non-transitive checks are a trap: `packages/shared` importing core, imported
 * by verifier, would satisfy every rule above. Fail on any package that is not
 * explicitly classified, so adding one is a deliberate act.
 */
const known = new Set([...Object.keys(FORBIDDEN)]);
for (const entry of readdirSync(join(ROOT, 'packages'))) {
  if (entry.startsWith('.')) continue;
  if (!statSync(join(ROOT, 'packages', entry)).isDirectory()) continue;
  if (!known.has(entry)) {
    violations.push(
      `packages/${entry}: new package is not classified in scripts/check-boundaries.mjs. ` +
        `Add it to FORBIDDEN with explicit rules -- an unclassified package can be used to ` +
        `launder a forbidden dependency transitively.`,
    );
  }
}

// The verifier's declared dependencies must also stay minimal and offline.
const verifierPkgPath = join(ROOT, 'packages/verifier/package.json');
if (existsSync(verifierPkgPath)) {
  const parsed = JSON.parse(readFileSync(verifierPkgPath, 'utf8'));
  // peer/optional deps install too; reading only `dependencies` was a bypass.
  const deps = [
    ...Object.keys(parsed.dependencies ?? {}),
    ...Object.keys(parsed.peerDependencies ?? {}),
    ...Object.keys(parsed.optionalDependencies ?? {}),
  ];
  const ALLOWED_VERIFIER_DEPS = ['@noble/ed25519', '@noble/hashes'];
  for (const d of deps) {
    if (!ALLOWED_VERIFIER_DEPS.includes(d)) {
      violations.push(`packages/verifier/package.json: runtime dependency '${d}' is not on the verifier allowlist (${ALLOWED_VERIFIER_DEPS.join(', ')})`);
    }
  }
}

if (violations.length > 0) {
  console.error('\n  Open-core boundary violations:\n');
  for (const v of violations) console.error('   x ' + v);
  console.error('\n  See docs/adr/0001-open-core-boundary.md for why this is enforced.\n');
  process.exit(1);
}

console.log('  Open-core boundaries intact: core !-> cloud, verifier/src !-> core|cloud, verifier offline.');
