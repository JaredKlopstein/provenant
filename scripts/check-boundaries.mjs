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

const IMPORT_RE = /(?:^|[^.\w])(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|(?:^|[^.\w])(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|mts|js|mjs)$/.test(full)) out.push(full);
  }
  return out;
}

const violations = [];

for (const [pkg, forbidden] of Object.entries(FORBIDDEN)) {
  const pkgDir = join(ROOT, 'packages', pkg);
  for (const file of walk(pkgDir)) {
    const src = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file);
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

// The verifier's declared dependencies must also stay minimal and offline.
const verifierPkgPath = join(ROOT, 'packages/verifier/package.json');
if (existsSync(verifierPkgPath)) {
  const deps = Object.keys(JSON.parse(readFileSync(verifierPkgPath, 'utf8')).dependencies ?? {});
  const ALLOWED_VERIFIER_DEPS = ['@noble/ed25519', '@noble/hashes'];
  for (const d of deps) {
    if (!ALLOWED_VERIFIER_DEPS.includes(d)) {
      violations.push(`packages/verifier/package.json: dependency '${d}' is not on the verifier allowlist (${ALLOWED_VERIFIER_DEPS.join(', ')})`);
    }
  }
}

if (violations.length > 0) {
  console.error('\n  Open-core boundary violations:\n');
  for (const v of violations) console.error('   x ' + v);
  console.error('\n  See docs/adr/0001-open-core-boundary.md for why this is enforced.\n');
  process.exit(1);
}

console.log('  Open-core boundaries intact (core !-> cloud, verifier !-> core|cloud, verifier offline).');
