import { z } from 'zod';
import { writeFileSync, existsSync } from 'node:fs';
import { defineAction, type NextAction } from '@provenant/core';
import { verifyBundle } from '@provenant/verifier';
import { exportBundle, bundleToJson } from '../bundle/export.js';
import { bundleToPdf } from '../bundle/pdf.js';
import { bundleToHtml } from '../bundle/html.js';

/**
 * Registered into core's action registry by importing this module, so the paid
 * capability appears as a normal command on the same CLI surface rather than a
 * separate tool. One registry, one set of conventions, one --help.
 */
export const bundleExportAction = defineAction({
  name: 'bundle.export',
  summary: 'Export a signed, self-contained evidence bundle',
  // `write`, not `read`: with --out this creates or OVERWRITES files on disk.
  // Declaring it read routed it around the registry's dry-run requirement and
  // around the test that enforces it, leaving the one mutation with no preview.
  sideEffect: 'write',
  description: {
    what: 'Packages a range of receipts, the agent key directory and every external anchor proof into one self-contained archive that a third party can verify offline, with no access to this system and no Provenant code from the paid package.',
    when: 'When someone outside your organisation needs to check what your agents did: an audit, a customer security questionnaire, an incident postmortem, or a regulatory request. Anchor first (anchor.now) so the bundle carries external proof rather than only your own word.',
    whenNot: 'Not for routine internal inspection -- use receipts.query, which is far cheaper. Do not export an unanchored range expecting it to persuade anyone: without an anchor the bundle is self-attested and the verifier will say so in writing.',
    cost: 'Reads and re-serializes every receipt in range, so it is linear in range size and the output is roughly 1KB per receipt. A PDF adds a second or two. On Provenant Cloud, bundles are billed per export on Starter and unlimited on Team.',
    returns: 'The bundle itself (or a path when --out is given), the range covered, whether it is externally anchored, and the verifier command a recipient should run to check it.',
  },
  input: z.object({
    from_seq: z.number().int().nonnegative().optional().describe('First chain position to include. Defaults to the start of the chain.'),
    to_seq: z.number().int().nonnegative().optional().describe('Last chain position to include. Defaults to the head.'),
    format: z.enum(['json', 'pdf', 'html', 'both', 'all']).default('json')
      .describe('json is the evidence. pdf and html are human-readable summaries with NO cryptographic value. Use "all" when sending to an auditor; html is also what the hosted verifier page serves.'),
    out: z.string().optional().describe('Write to this path instead of returning the bundle inline. Strongly recommended: a bundle is large.'),
    title: z.string().optional().describe('Title for the PDF report.'),
    organization: z.string().optional().describe('Organisation name for the PDF report.'),
  }),
  // The brief specifies `--from`/`--to`; unknown flags are rejected, so make
  // the documented spelling real rather than an error.
  aliases: { from: 'from_seq', to: 'to_seq' },
  output: z.object({
    range: z.object({ from_seq: z.number(), to_seq: z.number() }),
    receipt_count: z.number(),
    anchored: z.boolean(),
    anchor_count: z.number(),
    written: z.array(z.string()),
    would_write: z.array(z.string()).optional(),
    would_overwrite: z.array(z.string()).optional(),
    bundle: z.record(z.string(), z.unknown()).optional(),
    verify_with: z.string(),
    warning: z.string().nullable(),
  }),
  async handler(input, ctx) {
    const bundle = exportBundle(ctx.db, {
      ...(input.from_seq !== undefined ? { fromSeq: input.from_seq } : {}),
      ...(input.to_seq !== undefined ? { toSeq: input.to_seq } : {}),
    });

    // Verify our own output before handing it over. Shipping a bundle that
    // fails at audit time is worse than shipping none.
    const verdict = verifyBundle(bundle);
    const written: string[] = [];

    if (input.out) {
      const wantJson = input.format === 'json' || input.format === 'both' || input.format === 'all';
      const wantPdf = input.format === 'pdf' || input.format === 'both' || input.format === 'all';
      const wantHtml = input.format === 'html' || input.format === 'all';

      if (wantJson) {
        writeFileSync(input.out, bundleToJson(bundle));
        written.push(input.out);
      }
      if (wantPdf) {
        const pdfPath = input.out.replace(/\.json$/, '') + '.pdf';
        writeFileSync(pdfPath, await bundleToPdf(bundle, {
          ...(input.title ? { title: input.title } : {}),
          ...(input.organization ? { organization: input.organization } : {}),
        }));
        written.push(pdfPath);
      }
      if (wantHtml) {
        const htmlPath = input.out.replace(/\.json$/, '') + '.html';
        writeFileSync(htmlPath, bundleToHtml(bundle, {
          ...(input.title ? { title: input.title } : {}),
          ...(input.organization ? { organization: input.organization } : {}),
        }));
        written.push(htmlPath);
      }
    }

    return {
      range: bundle.range,
      receipt_count: bundle.receipts.length,
      anchored: verdict.anchored,
      anchor_count: bundle.anchors.length,
      written,
      ...(input.out ? {} : { bundle: bundle as unknown as Record<string, unknown> }),
      verify_with: `npx @provenant/verifier ${input.out ?? 'bundle.json'} --trust <authority-root.pem>`,
      warning: verdict.anchored
        ? null
        : 'This bundle is NOT externally anchored. It proves internal consistency only -- a recipient has ' +
          'no way to rule out that this history was rewritten. Run anchor.now before exporting evidence ' +
          'anyone is meant to rely on.',
    };
  },
  /** Shows exactly what would be written, and whether anything would be
   *  overwritten, without touching the filesystem. */
  async dryRun(input, ctx) {
    const bundle = exportBundle(ctx.db, {
      ...(input.from_seq !== undefined ? { fromSeq: input.from_seq } : {}),
      ...(input.to_seq !== undefined ? { toSeq: input.to_seq } : {}),
    });
    const verdict = verifyBundle(bundle);

    const would: string[] = [];
    if (input.out) {
      const base = input.out.replace(/\.json$/, '');
      if (input.format === 'json' || input.format === 'both' || input.format === 'all') would.push(input.out);
      if (input.format === 'pdf' || input.format === 'both' || input.format === 'all') would.push(base + '.pdf');
      if (input.format === 'html' || input.format === 'all') would.push(base + '.html');
    }
    const clobbered = would.filter((f) => existsSync(f));

    return {
      range: bundle.range,
      receipt_count: bundle.receipts.length,
      anchored: verdict.anchored,
      anchor_count: bundle.anchors.length,
      written: [],
      would_write: would,
      would_overwrite: clobbered,
      verify_with: `npx @provenant/verifier ${input.out ?? 'bundle.json'} --trust <authority-root.pem>`,
      warning: clobbered.length
        ? `DRY RUN: nothing was written. ${clobbered.length} existing file(s) WOULD BE OVERWRITTEN: ${clobbered.join(', ')}.`
        : 'DRY RUN: nothing was written.',
    };
  },

  nextActions(_input, output) {
    const next: NextAction[] = [];
    if (!output.anchored) {
      next.push({
        action: 'anchor.now',
        arguments: { backend: 'tsa' },
        why: 'This bundle carries no external proof. Anchor, then re-export.',
      });
    }
    next.push({
      action: 'chain.verify',
      arguments: {},
      why: 'Confirm the source chain is intact before relying on this export.',
    });
    return next;
  },
  examples: [
    {
      description: 'Full evidence pack for an auditor',
      arguments: { format: 'all', out: 'evidence.json', organization: 'Acme Corp' },
    },
    {
      description: 'Just the incident window',
      arguments: { from_seq: 1200, to_seq: 1310, out: 'incident-2026-09.json' },
    },
  ],
});
