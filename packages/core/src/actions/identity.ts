import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { defineAction } from '../registry/registry.js';
import { keyPath } from '../config.js';
import {
  generateKeypair,
  fromSecretKey,
  publicKeyToJwk,
  deriveAgentId,
  fingerprint,
  type Keypair,
} from '../crypto/keys.js';
import { toBase64Url, fromBase64Url } from '../crypto/hash.js';
import { jwkThumbprint } from '../crypto/keys.js';
import { ProvenantError } from '../errors.js';
import { registerAgent, listAgents, getAgent } from '../agents/store.js';
import { agentReliability } from '../agents/reliability.js';
import { project } from '../pagination.js';
import { TrustLevel } from '../receipt/schema.js';

/** On-disk key file. Mode 0600; the secret never leaves this machine. */
interface KeyFile {
  version: 1;
  secret_key: string;
  public_key: string;
  agent_id: string;
  created_at: string;
}

export function loadKeypair(storeDir: string): Keypair {
  const path = keyPath(storeDir);
  if (!existsSync(path)) {
    throw new ProvenantError({
      code: 'NO_KEYPAIR',
      message: `No keypair found at ${path}. Nothing was written.`,
      retryable: false,
      fix: {
        action: 'init',
        arguments: {},
        note: "Run 'provenant init' once to create a keypair and register this agent. It needs no network and no approval.",
      },
    });
  }
  const file = JSON.parse(readFileSync(path, 'utf8')) as KeyFile;
  return fromSecretKey(fromBase64Url(file.secret_key));
}

export function saveKeypair(storeDir: string, kp: Keypair): string {
  const path = keyPath(storeDir);
  mkdirSync(dirname(path), { recursive: true });
  const file: KeyFile = {
    version: 1,
    secret_key: toBase64Url(kp.secretKey),
    public_key: toBase64Url(kp.publicKey),
    agent_id: deriveAgentId(kp.publicKey),
    created_at: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600); // explicit: writeFileSync mode is subject to umask
  return path;
}

export const initAction = defineAction({
  name: 'init',
  summary: 'Create a local store, generate a keypair, and register this agent',
  sideEffect: 'write',
  description: {
    what: 'Creates the Provenant store directory, generates an Ed25519 keypair, and self-registers this agent so it can immediately begin recording receipts.',
    when: 'Once, the very first time an agent uses Provenant on a machine. Safe to call again: if a keypair already exists it is reused and this becomes a no-op.',
    whenNot: 'Do not call it before every record; it is not a session opener. If you already have an agent_id and a keypair, skip straight to `record`.',
    cost: 'Milliseconds. Writes two files to disk and one row to a local database. No network, no money, no external dependency.',
    returns: 'The agent_id you will use for every subsequent call, the store path, the key fingerprint, and whether a new key was created.',
  },
  input: z.object({
    display_name: z.string().min(1).max(200).optional()
      .describe('Human-readable name shown in the incident view. Defaults to the hostname.'),
    trust_level: TrustLevel.optional()
      .describe('AAT trust level L0-L4 this agent operates at. Defaults to L1.'),
    agent_version: z.string().optional().describe('Semver of the agent software. Defaults to 0.0.0.'),
    capabilities: z.array(z.string()).optional()
      .describe('Self-declared capability strings. Advisory only; nothing enforces them.'),
  }),
  output: z.object({
    agent_id: z.string(),
    store: z.string(),
    key_fingerprint: z.string(),
    key_created: z.boolean(),
    already_registered: z.boolean(),
  }),
  handler(input, ctx) {
    const path = keyPath(ctx.storeDir);
    const keyExisted = existsSync(path);
    const kp = keyExisted ? loadKeypair(ctx.storeDir) : generateKeypair();
    if (!keyExisted) saveKeypair(ctx.storeDir, kp);

    const agentId = deriveAgentId(kp.publicKey);
    const reg = registerAgent(ctx.db, {
      agentId,
      displayName: input.display_name ?? 'provenant-agent',
      publicKeyJwk: publicKeyToJwk(kp.publicKey),
      agentVersion: input.agent_version ?? '0.0.0',
      trustLevel: input.trust_level ?? 'L1',
      declaredCapabilities: input.capabilities ?? [],
    });

    return {
      agent_id: agentId,
      store: ctx.storeDir,
      key_fingerprint: fingerprint(kp.publicKey),
      key_created: !keyExisted,
      already_registered: !reg.created,
    };
  },
  dryRun(input, ctx) {
    const keyExisted = existsSync(keyPath(ctx.storeDir));
    const kp = keyExisted ? loadKeypair(ctx.storeDir) : generateKeypair();
    return {
      agent_id: deriveAgentId(kp.publicKey),
      store: ctx.storeDir,
      key_fingerprint: fingerprint(kp.publicKey),
      key_created: !keyExisted,
      already_registered: false,
    };
  },
  nextActions(_input, output) {
    return [
      {
        action: 'record',
        arguments: {
          action: 'example.action',
          action_detail: { note: 'replace with the action you actually took' },
          side_effect_class: 'write',
          outcome: 'success',
        },
        why: `Agent ${output.agent_id} is registered and can record receipts now.`,
      },
      { action: 'chain.verify', arguments: {}, why: 'Confirm the local chain is intact at any time.' },
    ];
  },
  examples: [
    { description: 'First run on a new machine', arguments: { display_name: 'billing-agent' } },
  ],
});

export const keygenAction = defineAction({
  name: 'keygen',
  summary: 'Generate an Ed25519 keypair without registering anything',
  // Overwriting a key abandons an identity: agent ids derive from the key, and
  // trust-on-first-use permanently binds an existing id to the key it was
  // registered with. That is not reversible, and the class must say so.
  sideEffect: 'irreversible',
  description: {
    what: 'Generates a new Ed25519 keypair and writes it to the store, without registering an agent or contacting anything. Refuses by default if a key already exists.',
    when: 'When you need a key before deciding on an identity -- provisioning a fleet, preparing a key to hand to a remote collector, or rotating to a new agent identity deliberately. Most callers should use `init` instead, which generates a key AND registers in one step.',
    whenNot: 'Do not use it to "reset" a working agent. Because an agent id is derived from its key, a new key is a NEW IDENTITY: receipts already written stay verifiable, but this machine can no longer write under the old id, and trust-on-first-use will refuse to rebind it. If you just want to start recording, run init.',
    cost: 'Milliseconds, no network. Writes one file at mode 0600. With --force it also archives the previous key, which permanently ends this machine\'s ability to write under the old identity.',
    returns: 'The new agent_id derived from the key, its fingerprint, the path written, and the path of the archived previous key if one was replaced.',
  },
  input: z.object({
    force: z.boolean().default(false)
      .describe('Replace an existing key. The old key is archived, never deleted, but the identity it represents is abandoned.'),
  }),
  output: z.object({
    agent_id: z.string(),
    key_fingerprint: z.string(),
    key_path: z.string(),
    replaced: z.boolean(),
    archived_previous_key: z.string().nullable(),
    registered: z.boolean(),
    note: z.string(),
  }),
  handler(input, ctx) {
    const path = keyPath(ctx.storeDir);
    const exists = existsSync(path);

    if (exists && !input.force) {
      const current = loadKeypair(ctx.storeDir);
      throw new ProvenantError({
        code: 'KEY_EXISTS',
        message:
          `A keypair already exists at ${path} for agent ${deriveAgentId(current.publicKey)}. ` +
          `Nothing was written. Generating a new key would abandon that identity: agent ids derive ` +
          `from the key, and trust-on-first-use will not rebind the old id to a new one.`,
        retryable: false,
        details: { key_path: path, current_agent_id: deriveAgentId(current.publicKey) },
        fix: {
          action: 'init',
          arguments: {},
          note:
            'If you meant to start recording, run init -- it reuses the existing key. If you truly ' +
            'intend a new identity, re-run keygen with --force; the old key is archived, not deleted.',
        },
      });
    }

    let archived: string | null = null;
    if (exists) {
      // Archive rather than delete. Key rotation is not implemented, so the old
      // key is the only way to interpret anything that referenced it.
      archived = `${path}.replaced-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      renameSync(path, archived);
    }

    const kp = generateKeypair();
    saveKeypair(ctx.storeDir, kp);

    return {
      agent_id: deriveAgentId(kp.publicKey),
      key_fingerprint: fingerprint(kp.publicKey),
      key_path: path,
      replaced: exists,
      archived_previous_key: archived,
      registered: false,
      note:
        'This key is NOT registered yet, so it cannot write receipts. Run agent.register (or init) ' +
        'to bind it to an agent id.',
    };
  },
  dryRun(input, ctx) {
    const path = keyPath(ctx.storeDir);
    const exists = existsSync(path);
    const preview = generateKeypair();
    return {
      agent_id: deriveAgentId(preview.publicKey),
      key_fingerprint: fingerprint(preview.publicKey),
      key_path: path,
      replaced: exists,
      archived_previous_key: exists ? `${path}.replaced-<timestamp>` : null,
      registered: false,
      note:
        `DRY RUN: nothing was written. ` +
        (exists && !input.force
          ? 'A key already exists and --force was not given, so the real call would FAIL rather than replace it.'
          : exists
            ? 'The real call would archive the existing key and abandon its identity.'
            : 'The real call would write a new key.') +
        ' The agent_id shown is from a throwaway preview key and will differ from the real one.',
    };
  },
  nextActions() {
    return [
      {
        action: 'agent.register',
        arguments: {},
        why: 'A key cannot write receipts until it is bound to an agent id.',
      },
    ];
  },
});

export const agentRegisterAction = defineAction({
  name: 'agent.register',
  summary: 'Bind an agent id to a public key (trust-on-first-use)',
  sideEffect: 'write',
  description: {
    what: 'Registers an agent id against an Ed25519 public key, permanently binding the two under trust-on-first-use. Defaults to this machine\'s own key, but can register a remote agent\'s public key instead.',
    when: 'To register under a chosen agent id rather than the key-derived default, to declare capabilities or a trust level, or -- as a collector operator -- to enrol a remote agent whose public key you were given out of band.',
    whenNot: 'Not needed after `init`, which already registers this machine. Re-registering the same id with the same key is a harmless no-op; re-registering it with a DIFFERENT key is refused, because rebinding an identity is exactly what trust-on-first-use exists to prevent.',
    cost: 'One local row write, no network, no approval. Permanent: the id-to-key binding cannot be changed afterwards, so choosing an id here is a one-way decision.',
    returns: 'The registered agent id, its key id, the trust-on-first-use key it is bound to, declared capabilities, and whether this call created the registration or found it already present.',
  },
  input: z.object({
    agent_id: z.string().min(1).max(512).optional()
      .describe('The id to register. Defaults to the self-certifying id derived from the public key.'),
    display_name: z.string().min(1).max(200).optional()
      .describe('Human-readable name shown in the incident view.'),
    public_key: z.string().optional()
      .describe('base64url raw Ed25519 public key, for registering a REMOTE agent. Omit to use this machine\'s key.'),
    trust_level: TrustLevel.optional().describe('AAT trust level L0-L4. Defaults to L1.'),
    agent_version: z.string().optional().describe('Semver of the agent software.'),
    capabilities: z.array(z.string()).optional()
      .describe('Self-declared capability strings. Advisory only; nothing enforces them.'),
  }),
  aliases: { name: 'display_name', id: 'agent_id', pubkey: 'public_key' },
  output: z.object({
    agent_id: z.string(),
    display_name: z.string(),
    key_id: z.string(),
    tofu_key_id: z.string(),
    trust_level: z.string(),
    declared_capabilities: z.array(z.string()),
    registered_at: z.string(),
    created: z.boolean(),
    note: z.string(),
  }),
  handler(input, ctx) {
    const publicKey = input.public_key
      ? fromBase64Url(input.public_key)
      : ctx.identity().publicKey;
    if (publicKey.length !== 32) {
      throw new ProvenantError({
        code: 'INVALID_INPUT',
        message: `public_key must be a 32-byte Ed25519 key encoded as base64url; got ${publicKey.length} bytes. Nothing was written.`,
        retryable: false,
        fix: { action: 'keygen', arguments: {}, note: 'Generate a key locally with keygen, or omit --public-key to use this machine\'s key.' },
      });
    }

    const agentId = input.agent_id ?? deriveAgentId(publicKey);
    const reg = registerAgent(ctx.db, {
      agentId,
      displayName: input.display_name ?? agentId,
      publicKeyJwk: publicKeyToJwk(publicKey),
      agentVersion: input.agent_version ?? '0.0.0',
      trustLevel: input.trust_level ?? 'L1',
      declaredCapabilities: input.capabilities ?? [],
    });

    return {
      ...reg,
      note: reg.created
        ? `Registered. '${agentId}' is now permanently bound to key ${reg.key_id}; that binding cannot be changed.`
        : `Already registered with this exact key, so nothing changed.`,
    };
  },
  dryRun(input, ctx) {
    const publicKey = input.public_key ? fromBase64Url(input.public_key) : ctx.identity().publicKey;
    const agentId = input.agent_id ?? deriveAgentId(publicKey);
    const existing = getAgent(ctx.db, agentId);
    const keyId = jwkThumbprint(publicKeyToJwk(publicKey));
    return {
      agent_id: agentId,
      display_name: input.display_name ?? agentId,
      key_id: keyId,
      tofu_key_id: existing?.tofuKeyId ?? keyId,
      trust_level: input.trust_level ?? 'L1',
      declared_capabilities: input.capabilities ?? [],
      registered_at: existing?.registeredAt ?? '(would be set now)',
      created: !existing,
      note: existing
        ? existing.keyId === keyId
          ? 'DRY RUN: nothing was written. This id is already registered to this key; the real call would be a no-op.'
          : `DRY RUN: nothing was written. The real call would FAIL -- '${agentId}' is bound to key ${existing.keyId} and trust-on-first-use will not rebind it.`
        : 'DRY RUN: nothing was written. The real call would create this registration.',
    };
  },
  nextActions(_input, output) {
    return [
      {
        action: 'record',
        arguments: {
          agent_id: output.agent_id,
          action: 'example.action',
          side_effect_class: 'write',
        },
        why: `${output.agent_id} can now record receipts.`,
      },
    ];
  },
  examples: [
    { description: 'Register this machine under a chosen id', arguments: { agent_id: 'billing-agent-eu', display_name: 'EU billing agent' } },
    { description: 'Enrol a remote agent from its public key', arguments: { agent_id: 'worker-7', public_key: '<base64url key>' } },
  ],
});

export const agentListAction = defineAction({
  name: 'agent.list',
  summary: 'List registered agents and their key bindings',
  sideEffect: 'read',
  description: {
    what: 'Lists every agent registered in this store with its trust level, current key id, and the trust-on-first-use key it was originally bound to.',
    when: 'During an incident or security review, to see which principals can write to this chain and whether any of them has a key id that differs from its original TOFU binding.',
    whenNot: 'Not needed before recording. An agent does not have to enumerate its peers to write its own receipts.',
    cost: 'One indexed local read. No network. Output grows with fleet size, so prefer --fields when the roster is large.',
    returns: 'An array of agents, each with agent_id, display_name, trust_level, key_id, tofu_key_id and registered_at.',
  },
  input: z.object({
    agent_id: z.string().optional().describe('Show only this agent.'),
    fields: z.array(z.string()).optional()
      .describe('Projection allowlist, e.g. ["agent_id","reliability"]. The cheapest way to cut response size on a large roster.'),
    reliability: z.boolean().default(true)
      .describe('Include derived reliability. Pass --reliability false to skip the per-agent receipt scan on a large store.'),
  }),
  aliases: { agent: 'agent_id', id: 'agent_id' },
  output: z.object({
    agents: z.array(z.record(z.string(), z.unknown())),
    count: z.number(),
    reliability_caveat: z.string(),
  }),
  handler(input, ctx) {
    const all = listAgents(ctx.db);
    const filtered = input.agent_id ? all.filter((a) => a.agent_id === input.agent_id) : all;

    const rows = filtered.map((a) => {
      const base: Record<string, unknown> = { ...a };
      if (input.reliability) base.reliability = agentReliability(ctx.db, a.agent_id);
      return project(base, input.fields);
    });

    return {
      agents: rows,
      count: rows.length,
      reliability_caveat:
        'Reliability rates are derived from receipts each agent chose to write, and unmeasurable ' +
        'rates are reported as null rather than zero. A rate of null means the signal does not exist ' +
        'yet (for example, no contracts are defined) -- it does NOT mean a clean record.',
    };
  },
});
