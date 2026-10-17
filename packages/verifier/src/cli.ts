/**
 * provenant-verify -- verify an evidence bundle offline.
 *
 * Exit codes are the contract for CI and scripts:
 *   0  verified
 *   1  verification FAILED (tampering, forgery, or a broken chain)
 *   2  the bundle could not be read at all, or the arguments were invalid
 *
 * The human output is written for someone during an incident who has to decide,
 * quickly, whether they can rely on this. It says what was established and --
 * just as importantly -- what was not.
 */
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { verifyBundle, type BundleVerdict, type VerifyOptions } from './bundle.js';
import { checkRun, type RunReport } from './run.js';

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
  0 verified   1 verification failed   2 bundle unreadable or bad arguments

This tool makes no network connections and shares no code with the Provenant
server or the commercial package. Everything it needs is in the bundle.`;

export function runVerify(argv: string[], io: VerifyIO = defaultIO): number {
  if (argv[0] === 'run') return runCheck(argv.slice(1), io);
  const json = argv.includes('--json');
  if (argv.length === 0 || argv.includes('--help')) {
    io.out(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  // A usage error must never fall through to a verdict: a mistyped flag that
  // silently did nothing (say, --trusted for --trust) would report a result
  // checked under options the caller never got.
  const usage = (message: string): number => {
    io.err(`provenant-verify: ${message}`);
    if (json) io.out(JSON.stringify({ ok: false, error: { code: 'USAGE', message } }, null, 2));
    return 2;
  };

  const opts: VerifyOptions = {};
  const trustFiles: string[] = [];
  const fingerprints: string[] = [];
  let file: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') continue;
    if (a === '--trust' || a === '--trust-fingerprint' || a === '--backdate-tolerance-ms') {
      const v = argv[i + 1];
      if (v === undefined || v === '' || v.startsWith('--')) return usage(`${a} needs a value. Try --help.`);
      i++;
      if (a === '--trust') trustFiles.push(v);
      else if (a === '--trust-fingerprint') fingerprints.push(v);
      else if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) {
        return usage(`--backdate-tolerance-ms must be a non-negative integer of milliseconds, got '${v}'.`);
      } else opts.backdateToleranceMs = Number(v);
    } else if (a.startsWith('--')) {
      return usage(
        `unknown option '${a}'. Options are --json, --trust, --trust-fingerprint, --backdate-tolerance-ms and --help.`,
      );
    } else if (file === null) file = a;
    else return usage(`unexpected argument '${a}'; give exactly one bundle file.`);
  }

  if (!file) return usage('no bundle file given. Try --help.');

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

const RUN_HELP = `provenant-verify run -- check one agent run's receipts, offline

USAGE
  provenant-verify run RECEIPTS --keys KEYS [--json]

ARGUMENTS
  RECEIPTS            JSON array of signed receipts in stored form, in chain
                      order (ascending seq).
  --keys <file>       JSON object mapping each provenant.key_id to its public
                      key as an Ed25519 JWK. Include every key the run was
                      signed under, rotated ones too.
  --json              Machine-readable report on stdout
  --help

REPORTS
  broken links        prev_hash mismatch, failed signature, or unknown key_id
  gaps                seq not contiguous from 0, or a first record whose
                      prev_hash is not null
  duplicate attempts  the same action, input_hash and turn_id under more than
                      one attempt_id. Reported, not a failure.

EXIT CODES
  0 intact   1 broken links or gaps   2 input unreadable`;

function runCheck(argv: string[], io: VerifyIO): number {
  if (argv.includes('--help')) {
    io.out(RUN_HELP);
    return 0;
  }

  let json = false;
  let keysFile: string | null = null;
  let file: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') json = true;
    else if (a === '--keys') keysFile = argv[++i] ?? null;
    else if (a.startsWith('--')) {
      io.err(`provenant-verify run: unknown option '${a}'. Options are --keys, --json and --help.`);
      return 2;
    } else if (file === null) file = a;
    else {
      io.err(`provenant-verify run: unexpected argument '${a}'; give exactly one RECEIPTS file.`);
      return 2;
    }
  }

  if (!file || !keysFile) {
    io.err(`provenant-verify run: ${!file ? 'no RECEIPTS file' : 'no --keys file'} given. Usage: provenant-verify run RECEIPTS --keys KEYS`);
    return 2;
  }

  let receipts: unknown;
  let keys: unknown;
  try {
    receipts = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    io.err(`provenant-verify run: could not read '${file}': ${String(err)}`);
    return 2;
  }
  if (!Array.isArray(receipts)) {
    io.err(`provenant-verify run: '${file}' must hold a JSON array of receipts.`);
    return 2;
  }
  try {
    keys = JSON.parse(readFileSync(keysFile, 'utf8'));
  } catch (err) {
    io.err(`provenant-verify run: could not read keys file '${keysFile}': ${String(err)}`);
    return 2;
  }
  if (keys === null || typeof keys !== 'object' || Array.isArray(keys)) {
    io.err(`provenant-verify run: keys file '${keysFile}' must hold a JSON object of key_id to public JWK.`);
    return 2;
  }

  const report = checkRun(receipts, keys as Record<string, unknown>);
  if (json) io.out(JSON.stringify(report, null, 2));
  else io.out(renderRun(report, file));
  return report.ok ? 0 : 1;
}

function renderRun(r: RunReport, file: string): string {
  const L: string[] = [];
  const rule = '-'.repeat(72);
  const where = (x: { seq: number | null; index: number }) => (x.seq === null ? `#${x.index}` : `seq ${x.seq}`);

  L.push(rule);
  L.push(r.ok ? 'RUN INTACT' : 'RUN BROKEN');
  L.push(rule);
  L.push('');
  L.push(`receipts   ${r.receiptsChecked} from ${file}`);

  if (r.brokenLinks.length) {
    L.push('');
    L.push(`BROKEN LINKS (${r.brokenLinks.length})`);
    for (const b of r.brokenLinks) {
      L.push(`  ${where(b)}  ${b.kind}`);
      L.push(`    ${b.message}`);
      if (b.expected) L.push(`    expected: ${b.expected}`);
      if (b.actual) L.push(`    actual  : ${b.actual}`);
    }
  }

  if (r.gaps.length) {
    L.push('');
    L.push(`GAPS (${r.gaps.length})`);
    for (const g of r.gaps) {
      L.push(`  ${where(g)}`);
      L.push(`    ${g.message}`);
    }
  }

  if (r.duplicateAttempts.length) {
    L.push('');
    L.push(`DUPLICATE ATTEMPTS (${r.duplicateAttempts.length}) -- reported, not a failure`);
    for (const d of r.duplicateAttempts) {
      L.push(`  ${d.action}  turn ${d.turnId}  input_hash ${d.inputHash}`);
      for (const a of d.attempts) {
        L.push(`    attempt ${a.attemptId}  at ${a.seqs.map((s) => (s === null ? '?' : `seq ${s}`)).join(', ')}`);
      }
    }
  }

  L.push('');
  L.push(
    r.ok
      ? 'Every record links to the one before it and verifies under the key it names. ' +
        'This proves internal consistency only: it cannot show that records were not cut ' +
        'from the end, or that the operator did not rewrite and re-sign the run. ' +
        'Only an anchored head binds the operator.'
      : 'Do not rely on records at or after the first broken link or gap without further evidence.',
  );
  L.push(rule);
  return L.join('\n');
}
