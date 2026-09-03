import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
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
import { ProvenantError } from '../errors.js';
import { registerAgent, listAgents } from '../agents/store.js';
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
  input: z.object({}),
  output: z.object({ agents: z.array(z.record(z.string(), z.unknown())), count: z.number() }),
  handler(_input, ctx) {
    const agents = listAgents(ctx.db);
    return { agents: agents as unknown as Array<Record<string, unknown>>, count: agents.length };
  },
});
