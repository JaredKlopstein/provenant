'use client';

import { useEffect, useState } from 'react';
import { EXHIBIT_DATA, type ExhibitData } from './exhibit-data';
import styles from './exhibit-chain.module.css';

/*
 * Exhibit A, ported from the Pages landing page (docs/index.html). Three real
 * receipts are hashed in the browser: altering the $42.50 refund breaks the link
 * to the next receipt, and re-signing the chain the way an operator holding the
 * key would repairs every link but still fails against the DigiCert anchor.
 *
 * Hashing is self-contained (RFC 8785 + WebCrypto SHA-256), so the site imports
 * nothing from the core or verifier packages (scripts/check-boundaries.mjs).
 */

export type ExhibitState = 'intact' | 'tampered' | 'resigned';
export type Verdict = 'intact' | 'tampered' | 'forged';

export interface ChainRow {
  readonly seq: number;
  readonly action: string;
  readonly amount: number | undefined;
  readonly prev: string | null;
  readonly self: string;
  readonly linkOk: boolean;
}

/** The amount the tamper button writes into the first receipt. */
export const ALTERED_AMOUNT = 99_999;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Receipt = { [key: string]: Json } & {
  prev_hash: string | null;
  action_detail: { [key: string]: Json };
  lacre: { [key: string]: Json };
};

/** RFC 8785 canonical JSON: keys sorted by UTF-16 code unit, no whitespace, ECMAScript number forms. */
export function jcs(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(value[k]!)}`).join(',')}}`;
}

/** Lowercase hex SHA-256 of a string's UTF-8 bytes, with the browser's (or Node's) WebCrypto. */
export async function sha256hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Recompute the chain exactly as the verifier does: hash each stored record and
 * check that the next record's prev_hash equals it. `tampered` alters the first
 * refund; `resigned` also relinks every hash after it, as an operator who holds
 * the signing key could.
 */
export async function computeChain(
  state: ExhibitState,
  data: ExhibitData = EXHIBIT_DATA,
  hash: (text: string) => Promise<string> = sha256hex,
): Promise<ChainRow[]> {
  const records = data.receipts.map((r) => JSON.parse(r.canonical) as Receipt);
  if (state !== 'intact') records[0]!.action_detail.amount_usd = ALTERED_AMOUNT;
  if (state === 'resigned') {
    let prev: string | null = null;
    for (const record of records) {
      record.prev_hash = prev;
      prev = await hash(jcs(record));
    }
  }
  const rows: ChainRow[] = [];
  let prevHash: string | null = null;
  for (const [i, record] of records.entries()) {
    const self = await hash(jcs(record));
    rows.push(rowOf(i, record, self, i === 0 ? record.prev_hash === null : record.prev_hash === prevHash));
    prevHash = self;
  }
  return rows;
}

/** The intact chain from the stored hashes, with no hashing, for the server render. */
export function storedChain(data: ExhibitData = EXHIBIT_DATA): ChainRow[] {
  return data.receipts.map((r, i) => {
    const record = JSON.parse(r.canonical) as Receipt;
    const prev = i === 0 ? null : data.receipts[i - 1]!.self_hash;
    return rowOf(i, record, r.self_hash, record.prev_hash === prev);
  });
}

function rowOf(seq: number, record: Receipt, self: string, linkOk: boolean): ChainRow {
  const amount = record.action_detail.amount_usd;
  return {
    seq,
    action: String(record.lacre.action),
    amount: typeof amount === 'number' ? amount : undefined,
    prev: record.prev_hash,
    self,
    linkOk,
  };
}

/** Intact if every link holds and the head is the anchored one; forged if the links hold but the anchor refuses. */
export function verdictOf(rows: readonly ChainRow[], anchorHead: string = EXHIBIT_DATA.anchor.head): Verdict {
  const headOk = rows[rows.length - 1]?.self === anchorHead;
  if (rows.every((r) => r.linkOk)) return headOk ? 'intact' : 'forged';
  return 'tampered';
}

const short = (hash: string) => `${hash.slice(0, 12)}…`;

/** A shortened hash on screen, with the full value as a tooltip and for screen readers. */
function Hash({ value }: { value: string | null }) {
  if (value === null) return <span className={styles.hash}>null</span>;
  return (
    <span className={styles.hash} title={value}>
      <span aria-hidden="true">{short(value)}</span>
      <span className={styles.srOnly}>{value}</span>
    </span>
  );
}

const usd = (amount: number) => `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

/** The authority's organization, from the token's subject DN (escaped commas kept). */
function authorityName(dn: string): string {
  const org = /(?:^|,\s*)O=((?:\\,|[^,])+)/.exec(dn)?.[1];
  return org ? org.replace(/\\,/g, ',').trim() : dn;
}

function verdictCopy(verdict: Verdict, rows: readonly ChainRow[], anchorDate: string) {
  if (verdict === 'intact') {
    return {
      title: 'Intact',
      body: `Every receipt hashes to the value the next one points at, and the head matches the timestamp signed on ${anchorDate}. Nothing has been altered.`,
    };
  }
  if (verdict === 'tampered') {
    const broken = rows.find((r) => !r.linkOk)?.seq;
    return {
      title: `Tampered: broken at seq ${broken}`,
      body: 'Changing the refund changed its hash, so the next receipt points at a value that no longer exists. A local check catches this. But an operator holds the signing key, so they can relink and re-sign every receipt after the one they changed.',
    };
  }
  return {
    title: 'Forged, and caught',
    body: 'Every link is consistent again, so local verification passes. The anchor is the one thing left that disagrees, and it cannot be redone: the timestamp authority signed the original head, and the operator does not hold its key.',
  };
}

export function ExhibitChain() {
  const data = EXHIBIT_DATA;
  const [state, setState] = useState<ExhibitState>('intact');
  const [rows, setRows] = useState<ChainRow[]>(() => storedChain(data));

  // Recompute in the browser whenever the state changes, the intact state included.
  useEffect(() => {
    if (!globalThis.crypto?.subtle) return;
    let current = true;
    void computeChain(state, data).then((next) => {
      if (current) setRows(next);
    });
    return () => {
      current = false;
    };
  }, [state, data]);

  const intactSelf = data.receipts.map((r) => r.self_hash);
  const anchorDate = data.anchor.time.slice(0, 10);
  const headOk = rows[rows.length - 1]?.self === data.anchor.head;
  const verdict = verdictOf(rows, data.anchor.head);
  const copy = verdictCopy(verdict, rows, anchorDate);

  return (
    <section aria-labelledby="exhibit-title" className={styles.exhibit}>
      <div className={styles.head}>
        <h2 id="exhibit-title">Exhibit A: live chain</h2>
        <span className={styles.live}>SHA-256 computed in your browser</span>
      </div>

      <ol className={styles.chain} aria-label="Receipts and anchor">
        {rows.map((r) => (
          <li key={`${state}-${r.seq}`} className={styles.receipt}>
            <div className={styles.top}>
              <span className={styles.seq}>SEQ {r.seq}</span>
              <span className={styles.action}>{r.action}</span>
              <span className={r.amount === ALTERED_AMOUNT ? `${styles.amount} ${styles.changed}` : styles.amount}>
                {r.amount === undefined ? <span aria-label="no amount">—</span> : usd(r.amount)}
              </span>
            </div>
            <div className={styles.link}>
              <span className={r.linkOk ? `${styles.pill} ${styles.ok}` : `${styles.pill} ${styles.bad}`}>
                {r.linkOk ? 'linked' : 'broken'}
              </span>
              <span className={r.self === intactSelf[r.seq] ? styles.hashline : `${styles.hashline} ${styles.flash}`}>
                prev <Hash value={r.prev} /> → self <Hash value={r.self} />
              </span>
            </div>
          </li>
        ))}
        <li key={`${state}-anchor`} className={styles.receipt}>
          <div className={styles.top}>
            <span className={styles.seq}>ANCHOR</span>
            <span className={styles.action}>
              {authorityName(data.anchor.authority)} · RFC 3161 · {anchorDate}
            </span>
          </div>
          <div className={styles.link}>
            <span className={headOk ? `${styles.pill} ${styles.ok}` : `${styles.pill} ${styles.bad}`}>
              {headOk ? 'matches' : 'mismatch'}
            </span>
            <span className={styles.hashline}>
              committed head <Hash value={data.anchor.head} />
            </span>
          </div>
        </li>
      </ol>

      <div
        className={verdict === 'intact' ? `${styles.verdict} ${styles.verdictOk}` : `${styles.verdict} ${styles.verdictBad}`}
        aria-live="polite"
      >
        <strong>{copy.title}</strong> <span>{copy.body}</span>
      </div>

      <div className={styles.controls}>
        <button type="button" onClick={() => setState('tampered')} disabled={state !== 'intact'}>
          Alter the refund to {usd(ALTERED_AMOUNT).replace('.00', '')}
        </button>
        <button type="button" className={styles.ghost} onClick={() => setState('resigned')} disabled={state !== 'tampered'}>
          Re-sign the chain like the operator would
        </button>
        <button type="button" className={styles.ghost} onClick={() => setState('intact')} disabled={state === 'intact'}>
          Reset
        </button>
      </div>
    </section>
  );
}
