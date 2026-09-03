/**
 * The discovery manifest.
 *
 * THE TEST THIS MUST PASS: an agent handed only the base URL (or only the
 * binary) and no other context must be able to operate the service correctly.
 * If it needs a README, this manifest is incomplete.
 *
 * `provenant discover --json` and (later) `GET /discover` return this exact
 * object, unauthenticated, so the CLI and the HTTP surface can never drift.
 */
import { z } from 'zod';
import { allActions } from './registry.js';
import { ERROR_CODES } from '../errors.js';
import { AAT_DRAFT_VERSION, PROVENANT_RECEIPT_VERSION } from '../receipt/schema.js';
import { DEFAULT_LIMIT, MAX_LIMIT } from '../pagination.js';

function jsonSchema(schema: z.ZodType): unknown {
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  } catch {
    return { type: 'object', description: 'schema could not be rendered' };
  }
}

export function buildManifest(): Record<string, unknown> {
  return {
    service: 'provenant',
    version: '0.1.0',
    receipt_version: PROVENANT_RECEIPT_VERSION,
    description:
      'Agent-native accountability. Agents write signed, hash-chained receipts of consequential actions; anyone can later verify that the record was not altered.',

    standards: {
      canonicalization: 'RFC 8785 (JCS)',
      hash: 'SHA-256',
      signature: 'Ed25519 (RFC 8032), base64url, over the JCS of the receipt without its signature field',
      key_format: 'RFC 8037 OKP JWK; key ids are RFC 7638 thumbprints',
      record_format: AAT_DRAFT_VERSION,
      record_format_caveat:
        'draft-sharif-agent-audit-trail has NO formal IETF standing and may change. We follow its record shape and chaining rule, but default to Ed25519 where the draft specifies ECDSA P-256, and carry the algorithm explicitly in provenant.signature_alg. Provenant-specific fields live under the "provenant" key.',
      chain_rule:
        'prev_hash(N) = hex(SHA-256(JCS(record(N-1)))) over the complete stored record including its signature. Genesis has prev_hash null.',
    },

    auth: {
      /** The CLI authenticates by possession of the key file; every network
       *  endpoint except the discovery surface requires an RFC 9421 signature.
       *  Saying "none" here was wrong and stalled agents that read this manifest
       *  from the collector and then got a 401. */
      scheme: 'ed25519-http-message-signatures (RFC 9421); local CLI uses the on-disk keypair',
      unauthenticated_endpoints: ['/discover', '/llms.txt', '/health', '/.well-known/http-message-signatures-directory', 'POST /agents'],
      required_covered_components: ['@method', '@authority', '@path'],
      also_required_with_a_body: ['content-digest'],
      replay_window_seconds: 60,
      max_signature_lifetime_seconds: 86400,
      note:
        'Sign with Ed25519 over the RFC 9421 signature base. Registration (POST /agents) is ' +
        'unauthenticated by design -- it is how you establish the key, under trust-on-first-use. ' +
        'No sessions, cookies, bearer tokens or refresh tokens exist anywhere.',
      worked_example: {
        request: 'POST /receipts HTTP/1.1 to collector.example',
        signature_base: [
          '"@method": POST',
          '"@authority": collector.example',
          '"@path": /receipts',
          '"content-digest": sha-256=:<base64 of SHA-256(body)>:',
          '"@signature-params": ("@method" "@authority" "@path" "content-digest");created=1788460000;expires=1788460300;keyid="<RFC 7638 JWK thumbprint>";alg="ed25519"',
        ].join('\n'),
        headers: {
          'signature-input': 'sig1=("@method" "@authority" "@path" "content-digest");created=1788460000;expires=1788460300;keyid="<thumbprint>";alg="ed25519"',
          signature: 'sig1=:<base64 Ed25519 over the signature base>:',
          'content-digest': 'sha-256=:<base64 of SHA-256(body)>:',
        },
        note: 'Join base lines with a single \n and do NOT add a trailing newline.',
      },
    },

    pagination: {
      style: 'opaque cursor',
      default_limit: DEFAULT_LIMIT,
      max_limit: MAX_LIMIT,
      note:
        'Pass next_cursor back verbatim. Cursors are seq-based, so they stay stable under concurrent appends. Use `fields` and `depth` to control response size -- every byte returned costs your context window.',
    },

    actions: allActions().map((a) => ({
      name: a.name,
      summary: a.summary,
      side_effect_class: a.sideEffect,
      supports_dry_run: Boolean(a.dryRun),
      /** alias -> canonical field name. Unknown options are rejected, so these
       *  are the only alternative spellings that will be accepted. */
      aliases: a.aliases ?? {},
      description: a.description,
      input_schema: jsonSchema(a.input as z.ZodType),
      output_schema: jsonSchema(a.output as z.ZodType),
      examples: a.examples ?? [],
    })),

    success: {
      shape: {
        ok: true,
        action: 'the.action.that.ran',
        result: { '...': 'the action-specific output, matching output_schema' },
        next_actions: [
          { action: 'another.action', arguments: { ready: 'to execute' }, why: 'why this is a sensible next step' },
        ],
      },
      note:
        'Every successful call returns this envelope. `next_actions` entries are fully-formed and ' +
        'ready to execute as-is, with ids already filled in -- they are not endpoint names. The array ' +
        'may be empty when there is no meaningful follow-up.',
    },

    errors: {
      shape: {
        error: {
          code: 'ERROR_CODE',
          message: 'Human and agent readable statement of what went wrong.',
          retryable: false,
          fix: {
            // A real action name, not a placeholder: the shape an agent reads
            // here should itself be executable, and every fix block we emit
            // names an action that exists in this manifest's `actions` list.
            action: 'record',
            arguments: { action: 'example.action', side_effect_class: 'write' },
            note: 'Whether the action executed, and what to do about it. Arguments are ready to execute as-is.',
          },
        },
      },
      codes: Object.values(ERROR_CODES),
      note: 'Every error states whether the action executed. If a fix block is present, its arguments are ready to execute as-is.',
    },

    /** Literal ordered calls from nothing to a first verified receipt. */
    quickstart: [
      {
        step: 1,
        why: 'Create a keypair and self-register. No approval, no network.',
        cli: 'provenant init --json',
        action: 'init',
        arguments: { display_name: 'my-agent' },
      },
      {
        step: 2,
        why: 'See exactly what would be written, without writing it.',
        cli: `provenant record --action refund.issue --action-detail '{"amount_usd":42}' --side-effect-class irreversible --dry-run --json`,
        action: 'record',
        arguments: {
          action: 'refund.issue',
          action_detail: { amount_usd: 42 },
          side_effect_class: 'irreversible',
        },
      },
      {
        step: 3,
        why: 'Write the receipt for real. Returns seq, self_hash and prev_hash.',
        cli: `provenant record --action refund.issue --action-detail '{"amount_usd":42}' --side-effect-class irreversible --json`,
        action: 'record',
        arguments: {
          action: 'refund.issue',
          action_detail: { amount_usd: 42 },
          side_effect_class: 'irreversible',
          idempotency_key: 'refund-0001',
        },
      },
      {
        step: 4,
        why: 'Prove the chain is intact. ok:true means nothing was altered locally.',
        cli: 'provenant chain verify --json',
        action: 'chain.verify',
        arguments: {},
      },
    ],

    limitations: [
      'A self-hosted chain is self-attested. It proves internal consistency, not that the operator left history alone. External anchoring is what makes it evidence to a third party.',
      'Trust-on-first-use binds an agent id to its first key, but cannot tell you that first key was legitimate.',
      'Provenant produces tamper-evident records that support logging obligations. It does not make anyone compliant with anything, and this is not legal advice.',
      'An anchor does not prove completeness. Truncating the receipts recorded since the last anchor leaves a chain that still verifies. Anchor cadence bounds that window; it does not eliminate it.',
      'A timestamp token carried inside a bundle proves nothing about who vouches for the signer. Trust must come from the reader, via a pinned fingerprint or trust anchor.',
    ],
  };
}
