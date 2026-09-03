import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  openDb, closeDb, appendReceipt, registerAgent, generateKeypair, deriveAgentId,
  publicKeyToJwk, signReceipt, receiptHash, canonicalReceiptJson, verifyChain,
  keyDirectory, createAnchor, registerAnchorBackend, chainId,
  type Db, type Keypair, type Receipt,
} from '@provenant/core';
import { verifyBundle } from '@provenant/verifier';
import { createTestAuthority, type TestAuthority } from '../src/anchor/test-authority.js';
import { exportBundle } from '../src/bundle/export.js';

let db: Db;
let kp: Keypair;
let agentId: string;
let tsa: TestAuthority;
const sessionId = randomUUID();

function record(over: Record<string, unknown> = {}) {
  return appendReceipt(db, {
    agentId,
    agentVersion: '1.0.0',
    trustLevel: 'L1',
    keyId: kp.keyId,
    secretKey: kp.secretKey,
    action: 'refund.issue',
    actionType: 'tool_call',
    actionDetail: { customer: 'c_1', amount_usd: 42 },
    sideEffectClass: 'irreversible',
    outcome: 'success',
    sessionId,
    ...over,
  } as Parameters<typeof appendReceipt>[1]);
}

function dropTriggers() {
  db.$client.exec(
    'DROP TRIGGER IF EXISTS receipts_no_update; DROP TRIGGER IF EXISTS receipts_no_delete;' +
      'DROP TRIGGER IF EXISTS anchors_no_update; DROP TRIGGER IF EXISTS anchors_no_delete;',
  );
}

/**
 * THE ADVERSARY MODEL.
 *
 * This is not a lazy attacker poking at one field. This is the operator, with:
 *   - full write access to the database,
 *   - the append-only triggers dropped,
 *   - and the agents' Ed25519 SIGNING KEYS.
 *
 * They edit a receipt and then rebuild the entire chain after it: recomputing
 * every prev_hash, re-signing every receipt, recomputing every self_hash. The
 * result is a chain that is internally flawless -- correct hashes, valid
 * signatures, unbroken links.
 *
 * The ONLY thing they do not have is the timestamp authority's key.
 *
 * If a bundle produced this way verifies, anchoring is not worth money and the
 * business model fails. That is the whole point of this file.
 */
function forgeHistory(editSeq: number, mutate: (receipt: Receipt) => void) {
  dropTriggers();
  const rows = db.$client
    .prepare('SELECT seq, canonical_json FROM receipts ORDER BY seq')
    .all() as Array<{ seq: number; canonical_json: string }>;

  let prevHash: string | null = null;
  for (const row of rows) {
    const receipt = JSON.parse(row.canonical_json) as Receipt;

    if (row.seq < editSeq) {
      prevHash = receiptHash(receipt);
      continue;
    }
    if (row.seq === editSeq) mutate(receipt);

    // Relink to the rewritten predecessor.
    receipt.prev_hash = prevHash;

    // Re-sign with the real agent key: the operator has it.
    const { signature: _old, ...unsigned } = receipt;
    const resigned = signReceipt(unsigned as Parameters<typeof signReceipt>[0], kp.secretKey);
    const json = canonicalReceiptJson(resigned);
    const hash = receiptHash(resigned);

    db.$client
      .prepare('UPDATE receipts SET canonical_json = ?, self_hash = ?, prev_hash = ? WHERE seq = ?')
      .run(json, hash, prevHash, row.seq);

    prevHash = hash;
  }
}

beforeEach(async () => {
  db = openDb(':memory:');
  kp = generateKeypair();
  agentId = deriveAgentId(kp.publicKey);
  registerAgent(db, {
    agentId,
    displayName: 'billing-agent',
    publicKeyJwk: publicKeyToJwk(kp.publicKey),
    agentVersion: '1.0.0',
  });
  tsa = createTestAuthority();
  registerAnchorBackend(tsa);
  for (let i = 0; i < 10; i++) record({ actionDetail: { step: i, amount_usd: 10 * i } });
});

afterEach(() => closeDb(db));

describe('an honest anchored bundle', () => {
  it('verifies offline and is recognised as real evidence', async () => {
    await createAnchor(db, 'test-tsa');
    const bundle = exportBundle(db);

    const v = verifyBundle(bundle, { trustedFingerprints: [tsa.rootFingerprint] });

    expect(v.ok).toBe(true);
    expect(v.anchored).toBe(true);
    expect(v.receipts_checked).toBe(10);
    expect(v.failures).toEqual([]);
    expect(v.anchors).toHaveLength(1);
    expect(v.anchors[0]!.is_evidence).toBe(true);
    expect(v.anchors[0]!.timestamp?.trusted).toBe(true);
    expect(v.conclusion).toContain('VERIFIED AND ANCHORED');
  });

  it('reports an unanchored bundle as self-attested, not as evidence', () => {
    const v = verifyBundle(exportBundle(db));
    expect(v.ok).toBe(true); // internally consistent...
    expect(v.anchored).toBe(false); // ...but proves nothing to a third party
    expect(v.conclusion).toContain('VERIFIED BUT NOT ANCHORED');
    expect(v.conclusion).toContain('self-attested');
  });

  it('does not mark the authority trusted without a trust list', async () => {
    await createAnchor(db, 'test-tsa');
    const v = verifyBundle(exportBundle(db));
    // The token is cryptographically sound...
    expect(v.anchors[0]!.timestamp?.ok).toBe(true);
    // ...but a root embedded in the bundle proves nothing on its own.
    expect(v.anchors[0]!.timestamp?.trusted).toBe(false);
    expect(v.conclusion).toContain('not in your trust list');
  });
});

/**
 * DEFINITION OF DONE #2 -- THE FORGERY TEST.
 * If any of these pass a forged bundle, the paywall is worthless.
 */
describe('the forgery test', () => {
  it('FIRST: proves a self-hosted chain alone cannot stop the operator', () => {
    // Establish the baseline honestly. Without an anchor, a full rebuild is
    // undetectable -- this is exactly why we do not sell local verification.
    forgeHistory(4, (r) => {
      (r.action_detail as Record<string, unknown>).amount_usd = 999_999;
    });

    const rows = db.$client
      .prepare('SELECT seq, canonical_json as canonical_json, self_hash as self_hash FROM receipts ORDER BY seq')
      .all() as Array<{ seq: number; canonical_json: string; self_hash: string }>;

    const local = verifyChain(rows, keyDirectory(db));
    expect(local.ok).toBe(true); // the forged chain passes local verification
    expect(JSON.parse(rows[4]!.canonical_json).action_detail.amount_usd).toBe(999_999);

    const v = verifyBundle(exportBundle(db));
    expect(v.ok).toBe(true);
    expect(v.anchored).toBe(false);
    // The verifier refuses to call it evidence, which is the honest outcome.
    expect(v.conclusion).toContain('could have rebuilt this entire history');
  });

  it('CANNOT insert a backdated receipt into an anchored range', async () => {
    await createAnchor(db, 'test-tsa');

    // The operator now rewrites history AFTER it was anchored, doing everything
    // right: new content, relinked hashes, valid re-signatures.
    forgeHistory(4, (r) => {
      (r.action_detail as Record<string, unknown>).amount_usd = 999_999;
      r.timestamp = '2020-01-01T00:00:00.000Z';
    });

    // Local verification is fooled completely.
    const rows = db.$client
      .prepare('SELECT seq, canonical_json as canonical_json, self_hash as self_hash FROM receipts ORDER BY seq')
      .all() as Array<{ seq: number; canonical_json: string; self_hash: string }>;
    expect(verifyChain(rows, keyDirectory(db)).ok).toBe(true);

    // The offline verifier is not.
    const v = verifyBundle(exportBundle(db), { trustedFingerprints: [tsa.rootFingerprint] });

    expect(v.ok).toBe(false);
    expect(v.anchored).toBe(false);
    const mismatch = v.failures.find((f) => f.kind === 'ANCHOR_HEAD_MISMATCH');
    expect(mismatch).toBeDefined();
    expect(mismatch!.seq).toBe(9);
    expect(v.conclusion).toContain('FORGERY DETECTED');
    // The anchor's own token is still perfectly valid -- it just commits to a
    // history that no longer exists.
    expect(v.anchors[0]!.timestamp?.ok).toBe(true);
    expect(v.anchors[0]!.head_matches).toBe(false);
  });

  it('CANNOT quietly re-anchor forged history over an existing attestation', async () => {
    await createAnchor(db, 'test-tsa');
    forgeHistory(4, (r) => {
      (r.action_detail as Record<string, unknown>).amount_usd = 999_999;
    });

    // The operator tries to launder the forgery by anchoring again at the same
    // position. The system refuses: an existing attestation commits that seq to
    // a different head, and minting a fresh timestamp over the new version would
    // destroy the only evidence that anything changed.
    await expect(createAnchor(db, 'test-tsa')).rejects.toMatchObject({
      code: 'ANCHOR_CONTRADICTION',
    });

    // The original anchor survives and still contradicts the forged history.
    const v = verifyBundle(exportBundle(db), { trustedFingerprints: [tsa.rootFingerprint] });
    expect(v.ok).toBe(false);
    expect(v.failures.some((f) => f.kind === 'ANCHOR_HEAD_MISMATCH')).toBe(true);
    expect(v.anchors.some((a) => !a.head_matches)).toBe(true);
  });

  it('re-anchoring an UNCHANGED head is an idempotent no-op, not a new request', async () => {
    // Anchoring is a paid, rate-limited network call. Asking twice for proof of
    // the same fact must not cost twice.
    const first = await createAnchor(db, 'test-tsa');
    const second = await createAnchor(db, 'test-tsa');
    expect(second.id).toBe(first.id);
    expect(second.proof.proven_time).toBe(first.proof.proven_time);
  });

  it('CANNOT delete the inconvenient anchor without losing all anchoring', async () => {
    await createAnchor(db, 'test-tsa');
    forgeHistory(4, (r) => {
      (r.action_detail as Record<string, unknown>).amount_usd = 999_999;
    });

    dropTriggers();
    db.$client.prepare('DELETE FROM anchors').run();

    const v = verifyBundle(exportBundle(db), { trustedFingerprints: [tsa.rootFingerprint] });
    // Removing the contradiction removes the proof. The bundle now verifies
    // internally but is explicitly NOT evidence -- so the forgery buys nothing.
    expect(v.ok).toBe(true);
    expect(v.anchored).toBe(false);
    expect(v.conclusion).toContain('NOT ANCHORED');
  });

  it('CANNOT replay a genuine token from a different chain', async () => {
    await createAnchor(db, 'test-tsa');
    const stolen = db.$client.prepare('SELECT * FROM anchors LIMIT 1').get() as Record<string, unknown>;

    // A second, independent store with its own history.
    const other = openDb(':memory:');
    const okp = generateKeypair();
    const oid = deriveAgentId(okp.publicKey);
    registerAgent(other, {
      agentId: oid, displayName: 'other', publicKeyJwk: publicKeyToJwk(okp.publicKey), agentVersion: '1.0.0',
    });
    for (let i = 0; i < 10; i++) {
      appendReceipt(other, {
        agentId: oid, agentVersion: '1.0.0', trustLevel: 'L1', keyId: okp.keyId,
        secretKey: okp.secretKey, action: 'refund.issue', actionType: 'tool_call',
        actionDetail: { step: i }, sideEffectClass: 'irreversible', outcome: 'success', sessionId,
      });
    }

    // Paste the other chain's genuine, valid token into this store's anchors.
    other.$client
      .prepare(
        'INSERT INTO anchors (id, seq, head_hash, receipt_count, chain_id, backend, proof_type, proof_token, proven_time, authority, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        stolen.id, stolen.seq, stolen.head_hash, stolen.receipt_count, stolen.chain_id,
        stolen.backend, stolen.proof_type, stolen.proof_token, stolen.proven_time,
        stolen.authority, stolen.created_at,
      );

    const v = verifyBundle(exportBundle(other), { trustedFingerprints: [tsa.rootFingerprint] });
    expect(v.ok).toBe(false);
    // Caught twice over: the head does not match, and the statement names a
    // different chain_id. The chain id is why timestamping a STATEMENT rather
    // than a bare hash matters.
    expect(v.failures.some((f) => f.kind === 'ANCHOR_HEAD_MISMATCH')).toBe(true);
    expect(v.failures.some((f) => f.kind === 'ANCHOR_CHAIN_MISMATCH')).toBe(true);
    expect(chainId(other)).not.toBe(stolen.chain_id);
    closeDb(other);
  });

  it('CANNOT append a backdated receipt AFTER the anchor', async () => {
    await createAnchor(db, 'test-tsa');
    // The anchor covers 0..9. Appending seq 10 is legitimate -- but claiming it
    // happened in 2020 is not, because the anchor proves the chain had already
    // reached seq 9 today.
    record({ timestamp: '2020-01-01T00:00:00.000Z', actionDetail: { backdated: true } });

    const v = verifyBundle(exportBundle(db), { trustedFingerprints: [tsa.rootFingerprint] });
    expect(v.ok).toBe(false);
    const temporal = v.failures.find((f) => f.kind === 'ANCHOR_TEMPORAL_VIOLATION');
    expect(temporal).toBeDefined();
    expect(temporal!.seq).toBe(10);
    expect(temporal!.message).toContain('backdating');
  });

  it('does NOT report an un-anchored tail as anchored evidence', async () => {
    // GAP found in audit: `anchored` is a bare some(is_evidence), so appending
    // fabricated receipts after the anchor still produced anchored:true with no
    // structured signal that the tail was unproven.
    await createAnchor(db, 'test-tsa'); // covers 0..9
    record({ actionDetail: { fabricated: 1 } });
    record({ actionDetail: { fabricated: 2 } });

    const v = verifyBundle(exportBundle(db), { trustedFingerprints: [tsa.rootFingerprint] });

    expect(v.receipts_checked).toBe(12);
    expect(v.anchored).toBe(true);
    // The machine-readable fields must expose the gap, not only the prose.
    expect(v.anchored_through_seq).toBe(9);
    expect(v.unanchored_receipt_count).toBe(2);
    expect(v.warnings.join(' ')).toMatch(/are NOT covered by any external anchor/);
    expect(v.conclusion).toContain('ANCHORED THROUGH SEQ 9');
    expect(v.conclusion).toContain('are NOT anchored');
  });

  it('reports whether the anchoring authority is actually trusted', async () => {
    await createAnchor(db, 'test-tsa');
    const untrusted = verifyBundle(exportBundle(db));
    expect(untrusted.anchored).toBe(true);
    expect(untrusted.anchor_authority_trusted).toBe(false);

    const trusted = verifyBundle(exportBundle(db), { trustedFingerprints: [tsa.rootFingerprint] });
    expect(trusted.anchor_authority_trusted).toBe(true);
  });

  it('ignores the bundle summary entirely, since it is unhashed operator prose', async () => {
    // GAP found in audit: `summary` sits outside everything that is hashed, so
    // an operator can rewrite it freely. The verifier must never read it, and
    // must not be contradicted by it.
    await createAnchor(db, 'test-tsa');
    const bundle = exportBundle(db);
    const lied = {
      ...bundle,
      summary: {
        ...(bundle.summary as object),
        unverified_note: 'Everything here is fully anchored and independently proven.',
        anchored_through_seq: 9999,
        receipt_count: 1,
      },
    };

    const honest = verifyBundle(bundle, { trustedFingerprints: [tsa.rootFingerprint] });
    const withLies = verifyBundle(lied, { trustedFingerprints: [tsa.rootFingerprint] });

    // Rewriting the summary changes nothing about the verdict.
    expect(withLies.anchored_through_seq).toBe(honest.anchored_through_seq);
    expect(withLies.receipts_checked).toBe(honest.receipts_checked);
    expect(withLies.conclusion).toBe(honest.conclusion);
  });

  it('tolerates ordinary clock skew rather than crying forgery', async () => {
    await createAnchor(db, 'test-tsa');
    // A minute of NTP drift must not be reported as backdating: a verifier that
    // fires on skew trains operators to ignore it.
    record({ timestamp: new Date(Date.now() - 60_000).toISOString() });

    const v = verifyBundle(exportBundle(db), { trustedFingerprints: [tsa.rootFingerprint] });
    expect(v.failures.filter((f) => f.kind === 'ANCHOR_TEMPORAL_VIOLATION')).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('CANNOT swap in a token minted by an untrusted authority', async () => {
    // The operator stands up their own CA and mints a token over the forged
    // head. It is a structurally perfect RFC 3161 token.
    const rogue = createTestAuthority();
    registerAnchorBackend({ ...rogue, name: 'rogue' });
    await createAnchor(db, 'rogue');

    // Pin the REAL DigiCert root, the one a reviewer would actually trust and
    // that an attacker can copy from this repo's own public sample bundle.
    // Pinning an arbitrary nonexistent fingerprint would make this test pass
    // trivially and prove nothing.
    const DIGICERT_ROOT_FP = '33846b545a49c9be4903c60e01713c1bd4e4ef31ea65cd95d69e62794f30b941';
    const v = verifyBundle(exportBundle(db), { trustedFingerprints: [DIGICERT_ROOT_FP] });

    // Cryptographically sound, and it does commit to the real head...
    expect(v.anchors[0]!.timestamp?.ok).toBe(true);
    // ...but it is not from anyone the reviewer trusts, and the verifier says so
    // instead of quietly accepting the bundle's own root.
    expect(v.anchors[0]!.timestamp?.trusted).toBe(false);
    expect(v.conclusion).toContain('not in your trust list');
  });
});
