/**
 * Human-readable evidence report.
 *
 * IMPORTANT FRAMING, and it is stated on the document itself: the PDF is NOT
 * the evidence. The JSON bundle is. A PDF can be edited by anyone with a text
 * editor and carries no cryptography. This document exists so a human -- an
 * auditor, a security reviewer, a regulator -- can understand what the evidence
 * says and how to check it themselves, not so it can be waved around as proof.
 *
 * Selling a beautiful PDF that people mistake for proof would be the dishonest
 * version of this product.
 */
import PDFDocument from 'pdfkit';
import type { Bundle } from '@provenant/verifier';
import { verifyBundle, type VerifyOptions } from '@provenant/verifier';

export interface PdfOptions extends VerifyOptions {
  title?: string;
  organization?: string;
}

export function bundleToPdf(bundle: Bundle, opts: PdfOptions = {}): Promise<Buffer> {
  const verdict = verifyBundle(bundle, opts);
  // Same rule as the HTML report: an anchor from an authority the reader has not
  // vouched for must not be presented as settled proof. `is_evidence` requires
  // only that the token is sound and commits to this history -- it deliberately
  // says nothing about who vouches for the signer.
  const trustedAnchor = verdict.anchors.some((a) => a.is_evidence && a.timestamp?.trusted);
  const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
  const chunks: Buffer[] = [];

  return new Promise((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const H = (t: string, size = 13) =>
      doc.moveDown(0.8).font('Helvetica-Bold').fontSize(size).fillColor('#111').text(t);
    const P = (t: string, color = '#333') =>
      doc.font('Helvetica').fontSize(9.5).fillColor(color).text(t, { align: 'left' });
    const KV = (k: string, v: string) => {
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#555').text(k, { continued: true });
      doc.font('Courier').fontSize(9).fillColor('#111').text('  ' + v);
    };

    // ---- header ----
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#111').text(opts.title ?? 'Provenant Evidence Report');
    doc.font('Helvetica').fontSize(9).fillColor('#666')
      .text(`${opts.organization ? opts.organization + ' — ' : ''}generated ${new Date().toISOString()}`);
    doc.moveDown(0.5);
    doc.moveTo(54, doc.y).lineTo(558, doc.y).strokeColor('#ddd').stroke();

    // ---- verdict banner ----
    const good = verdict.ok && verdict.anchored && trustedAnchor;
    const warn = verdict.ok && (!verdict.anchored || !trustedAnchor);
    doc.moveDown(0.8);
    doc.rect(54, doc.y, 504, 26).fill(good ? '#e7f5ec' : warn ? '#fff6e5' : '#fdeaea');
    doc.fillColor(good ? '#1a7f45' : warn ? '#8a5a00' : '#a11')
      .font('Helvetica-Bold').fontSize(12)
      .text(
        verdict.ok
          ? verdict.anchored
            ? trustedAnchor
              ? 'VERIFIED — EXTERNALLY ANCHORED'
              : 'VERIFIED — AUTHORITY NOT VERIFIED'
            : 'VERIFIED — NOT ANCHORED'
          : 'VERIFICATION FAILED',
        62, doc.y - 19,
      );
    doc.moveDown(1.4);
    P(verdict.conclusion, '#222');

    // ---- scope ----
    H('Scope');
    KV('Chain', bundle.chain_id ?? 'unknown');
    KV('Receipts', String(verdict.receipts_checked));
    if (verdict.range) KV('Positions', `seq ${verdict.range.from_seq} through ${verdict.range.to_seq}`);
    const s = bundle.summary as Record<string, unknown> | undefined;
    if (s?.time_range) {
      const tr = s.time_range as { first: string; last: string };
      KV('Time span', `${tr.first} to ${tr.last}`);
    }
    if (s) {
      KV('Agents', String(s.agent_count ?? '—'));
      KV('Irreversible actions', String(s.irreversible_actions ?? 0));
    }

    // ---- anchors ----
    H('External attestations');
    if (verdict.anchors.length === 0) {
      P('None. Nothing in this bundle is externally anchored, so it proves only that the records are internally consistent with each other. The operator could have produced all of it.', '#8a5a00');
    } else {
      for (const a of verdict.anchors) {
        doc.moveDown(0.3);
        KV('Position', `seq ${a.seq}`);
        KV('Status', a.is_evidence ? 'EVIDENCE — constrains the operator' : 'not evidence');
        if (a.proven_time) KV('Attested time', a.proven_time);
        if (a.timestamp?.signer) KV('Authority', a.timestamp.signer);
        if (a.timestamp?.chain.top) KV('Trust anchor', a.timestamp.chain.top.subject);
        if (a.timestamp?.chain.top) KV('  fingerprint', a.timestamp.chain.top.fingerprint_sha256);
        KV('In your trust list', a.timestamp?.trusted ? 'yes' : 'NO — confirm independently');
        P(a.note, '#555');
      }
    }

    // ---- failures ----
    if (verdict.failures.length) {
      H('Failures');
      for (const f of verdict.failures.slice(0, 40)) {
        doc.moveDown(0.2);
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#a11')
          .text(`${f.seq === null ? 'bundle' : `seq ${f.seq}`} — ${f.kind}`);
        P(f.message, '#333');
        if (f.expected) P(`expected: ${f.expected}`, '#666');
        if (f.actual) P(`actual:   ${f.actual}`, '#666');
      }
      if (verdict.failures.length > 40) P(`… and ${verdict.failures.length - 40} more. See the JSON bundle.`, '#666');
      H('Still provably intact', 11);
      P(verdict.intact_ranges.map((r) => `seq ${r.from_seq}–${r.to_seq}`).join(', ') || 'nothing', '#333');
    }

    // ---- activity ----
    if (s?.by_action) {
      H('Activity by action');
      for (const [action, count] of Object.entries(s.by_action as Record<string, number>).slice(0, 15)) {
        KV(action, String(count));
      }
    }

    // ---- how to check ----
    H('How to verify this yourself');
    P(
      'This PDF is a summary, not the evidence. It has no cryptographic value and anyone can edit it. ' +
      'The evidence is the accompanying JSON bundle. To check it independently, without trusting the ' +
      'operator of this system and without a network connection:',
      '#222',
    );
    doc.moveDown(0.4);
    doc.font('Courier').fontSize(9).fillColor('#111')
      .text('  npx @provenant/verifier bundle.json --trust <authority-root.pem>');
    doc.moveDown(0.4);
    P(
      'The verifier is MIT licensed, makes no network connections, and shares no code with the software ' +
      'that produced this bundle. It re-derives every hash and re-checks every signature from the bundle ' +
      'contents alone.',
      '#555',
    );

    H('What this does and does not establish', 11);
    P(
      '• It establishes that the receipts shown are internally consistent and were signed by the ' +
      'registered agent keys.',
      '#333',
    );
    P(
      !verdict.anchored
        ? '• It does NOT establish that the history is unaltered. Without an external anchor, the operator ' +
          'could have rewritten everything and it would still verify.'
        : trustedAnchor
          ? '• It establishes, via a timestamp authority you have told this tool to trust, that this exact ' +
            'history existed at the attested time and has not been altered since.'
          : '• It does NOT yet establish that the history is unaltered. A timestamp token is present and ' +
            'cryptographically sound, but the authority that signed it is not in your trust list, so ' +
            'nothing rules out that the signer was chosen by whoever produced this bundle. Confirm the ' +
            'fingerprint above against the authority directly, then re-run with --trust-fingerprint.',
      trustedAnchor ? '#1a7f45' : '#8a5a00',
    );
    P(
      '• It does NOT make anyone compliant with any regulation. Provenant produces tamper-evident ' +
      'records that support logging obligations. This is not legal advice.',
      '#333',
    );

    doc.end();
  });
}
