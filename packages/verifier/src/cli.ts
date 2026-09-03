/**
 * provenant-verify -- verify an evidence bundle offline.
 *
 * Exit codes are the contract for CI and scripts:
 *   0  verified
 *   1  verification FAILED (tampering, forgery, or a broken chain)
 *   2  the bundle could not be read at all
 *
 * The human output is written for someone during an incident who has to decide,
 * quickly, whether they can rely on this. It says what was established and --
 * just as importantly -- what was not.
 */
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { verifyBundle, type BundleVerdict, type VerifyOptions } from './bundle.js';

export interface VerifyIO {
  out(s: string): void;
  err(s: string): void;
}

const defaultIO: VerifyIO = {
  out: (s) => process.stdout.write(s + '\n'),
  err: (s) => process.stderr.write(s + '\n'),
};

const HELP = `provenant-verify -- verify a Provenant evidence bundle, offline

USAGE
  provenant-verify <bundle.json> [options]

OPTIONS
  --json              Machine-readable verdict on stdout
  --trust <file>      PEM file of timestamp-authority certificates you trust.
                      May be repeated. Without it the token is still checked
                      cryptographically, but reported as untrusted -- because a
                      root embedded in the bundle proves nothing on its own.
  --trust-fingerprint <sha256>
                      Pin an authority by certificate fingerprint instead.
  --backdate-tolerance-ms <n>
                      Clock skew allowed before a post-anchor receipt claiming
                      an earlier time is treated as backdating (default 300000).
  --help

EXIT CODES
  0 verified   1 verification failed   2 bundle unreadable

This tool makes no network connections and shares no code with the Provenant
server or the commercial package. Everything it needs is in the bundle.`;

export function runVerify(argv: string[], io: VerifyIO = defaultIO): number {
  const json = argv.includes('--json');
  if (argv.length === 0 || argv.includes('--help')) {
    io.out(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const opts: VerifyOptions = {};
  const trustFiles: string[] = [];
  const fingerprints: string[] = [];
  let file: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--trust') trustFiles.push(argv[++i] ?? '');
    else if (a === '--trust-fingerprint') fingerprints.push(argv[++i] ?? '');
    else if (a === '--backdate-tolerance-ms') opts.backdateToleranceMs = Number(argv[++i]);
    else if (!a.startsWith('--')) file = a;
  }

  if (!file) {
    io.err('provenant-verify: no bundle file given. Try --help.');
    return 2;
  }

  let bundle: unknown;
  try {
    bundle = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    io.err(`provenant-verify: could not read '${file}': ${String(err)}`);
    return 2;
  }

  const anchors: X509Certificate[] = [];
  for (const f of trustFiles) {
    try {
      const pem = readFileSync(f, 'utf8');
      for (const block of pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []) {
        anchors.push(new X509Certificate(block));
      }
    } catch (err) {
      io.err(`provenant-verify: could not read trust file '${f}': ${String(err)}`);
      return 2;
    }
  }
  if (anchors.length) opts.trustAnchors = anchors;
  if (fingerprints.length) opts.trustedFingerprints = fingerprints;

  const verdict = verifyBundle(bundle, opts);

  if (json) io.out(JSON.stringify(verdict, null, 2));
  else io.out(render(verdict));

  return verdict.ok ? 0 : 1;
}

function render(v: BundleVerdict): string {
  const L: string[] = [];
  const rule = '-'.repeat(72);

  L.push(rule);
  L.push(v.ok ? (v.anchored ? 'VERIFIED / ANCHORED' : 'VERIFIED / NOT ANCHORED') : 'VERIFICATION FAILED');
  L.push(rule);
  L.push('');
  L.push(v.conclusion);
  L.push('');
  L.push(`chain      ${v.chain_id ?? 'unknown'}`);
  if (v.range) L.push(`range      seq ${v.range.from_seq} to ${v.range.to_seq} (${v.receipts_checked} receipts)`);

  if (v.anchors.length) {
    L.push('');
    L.push('ANCHORS');
    for (const a of v.anchors) {
      L.push(`  seq ${a.seq}  [${a.backend}]  ${a.is_evidence ? 'EVIDENCE' : 'not evidence'}`);
      if (a.proven_time) L.push(`    attested time : ${a.proven_time}`);
      if (a.timestamp?.signer) L.push(`    authority     : ${a.timestamp.signer}`);
      if (a.timestamp?.chain.top) {
        L.push(`    chain top     : ${a.timestamp.chain.top.subject}`);
        L.push(`    fingerprint   : ${a.timestamp.chain.top.fingerprint_sha256}`);
      }
      L.push(`    trusted by you: ${a.timestamp?.trusted ? 'yes' : 'NO -- pass --trust or --trust-fingerprint'}`);
      L.push(`    ${a.note}`);
    }
  }

  if (v.failures.length) {
    L.push('');
    L.push(`FAILURES (${v.failures.length})`);
    for (const f of v.failures) {
      L.push(`  ${f.seq === null ? 'bundle' : `seq ${f.seq}`}  ${f.kind}`);
      L.push(`    ${f.message}`);
      if (f.expected) L.push(`    expected: ${f.expected}`);
      if (f.actual) L.push(`    actual  : ${f.actual}`);
    }
    L.push('');
    L.push(`STILL PROVABLY INTACT: ${v.intact_ranges.map((r) => `seq ${r.from_seq}-${r.to_seq}`).join(', ') || 'nothing'}`);
  }

  if (v.warnings.length) {
    L.push('');
    L.push('WARNINGS');
    for (const w of v.warnings) L.push(`  - ${w}`);
  }

  L.push('');
  L.push(rule);
  return L.join('\n');
}
