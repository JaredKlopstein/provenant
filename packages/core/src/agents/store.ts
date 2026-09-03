/**
 * Agent identity: self-registration with trust-on-first-use.
 *
 * No email, no captcha, no OAuth redirect, no human approval. An agent presents
 * a public key and starts writing. That is the whole point -- a registration
 * flow that requires a human is a registration flow agents cannot complete.
 *
 * What TOFU does and does not buy you, stated honestly:
 *   - It DOES bind an agent id to one key permanently. After first registration,
 *     a different key claiming the same id is rejected, so an attacker cannot
 *     silently take over an existing identity.
 *   - It does NOT tell you the first key was legitimate. Nothing local can.
 *     Provenance of the first key is established out of band (a deployment
 *     pipeline, a key directory) or not at all.
 */
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, type AgentRow } from '../db/schema.js';
import { ProvenantError } from '../errors.js';
import { jwkThumbprint, type AgentJwk } from '../crypto/keys.js';
import { nowRfc3339 } from '../chain/append.js';
import type { TrustLevel } from '../receipt/schema.js';

export interface RegisterInput {
  agentId: string;
  displayName: string;
  publicKeyJwk: AgentJwk;
  agentVersion?: string;
  trustLevel?: TrustLevel;
  declaredCapabilities?: string[];
}

export interface RegisteredAgent {
  agent_id: string;
  display_name: string;
  agent_version: string;
  trust_level: string;
  key_id: string;
  tofu_key_id: string;
  declared_capabilities: string[];
  registered_at: string;
  /** False when this call was a no-op re-registration of the same key. */
  created: boolean;
}

export function getAgent(db: Db, agentId: string): AgentRow | null {
  return db.select().from(agents).where(eq(agents.agentId, agentId)).get() ?? null;
}

export function registerAgent(db: Db, input: RegisterInput): RegisteredAgent {
  const keyId = jwkThumbprint(input.publicKeyJwk);
  const existing = getAgent(db, input.agentId);

  if (existing) {
    // Re-registering with the SAME key is idempotent, not an error: an agent
    // restarting must not have to know whether it registered before.
    if (existing.keyId === keyId) {
      return toPublic(existing, false);
    }
    throw new ProvenantError({
      code: 'AGENT_KEY_MISMATCH',
      message:
        `Agent '${input.agentId}' is already registered to key ${existing.keyId}, ` +
        `but a different key (${keyId}) was presented. Trust-on-first-use binds an ` +
        `agent id to its first key permanently. Nothing was written.`,
      retryable: false,
      details: { registered_key_id: existing.keyId, presented_key_id: keyId },
      fix: {
        // Must name an action that actually exists in the registry -- a fix
        // block pointing at a nonexistent action is worse than none, because an
        // agent will spend a turn discovering it is a dead end.
        action: 'agent.list',
        arguments: {},
        note:
          'Sign with the key already registered to this agent id. If this agent legitimately ' +
          'rotated keys, key rotation is not implemented yet; register under a different ' +
          'agent_id instead. Run agent.list to see the key bound to each id.',
      },
    });
  }

  const registeredAt = nowRfc3339();
  db.insert(agents)
    .values({
      agentId: input.agentId,
      displayName: input.displayName,
      agentVersion: input.agentVersion ?? '0.0.0',
      trustLevel: input.trustLevel ?? 'L1',
      publicKeyJwk: JSON.stringify(input.publicKeyJwk),
      keyId,
      tofuKeyId: keyId,
      declaredCapabilities: JSON.stringify(input.declaredCapabilities ?? []),
      registeredAt,
    })
    .run();

  return toPublic(getAgent(db, input.agentId)!, true);
}

export function requireAgent(db: Db, agentId: string): AgentRow {
  const row = getAgent(db, agentId);
  if (!row) {
    throw new ProvenantError({
      code: 'AGENT_NOT_FOUND',
      message: `No agent registered with id '${agentId}'. Nothing was written.`,
      retryable: false,
      fix: {
        action: 'init',
        arguments: {},
        note:
          'Run init to create a keypair and self-register this machine. Registration is ' +
          'self-service and needs no approval. To see which agents already exist, run agent.list.',
      },
    });
  }
  return row;
}

export function listAgents(db: Db): RegisteredAgent[] {
  return db
    .select()
    .from(agents)
    .all()
    .map((r) => toPublic(r, false));
}

/** The public key directory used by verification. */
export function keyDirectory(db: Db): Record<string, AgentJwk> {
  const out: Record<string, AgentJwk> = {};
  for (const row of db.select().from(agents).all()) {
    out[row.agentId] = JSON.parse(row.publicKeyJwk) as AgentJwk;
  }
  return out;
}

function toPublic(row: AgentRow, created: boolean): RegisteredAgent {
  return {
    agent_id: row.agentId,
    display_name: row.displayName,
    agent_version: row.agentVersion,
    trust_level: row.trustLevel,
    key_id: row.keyId,
    tofu_key_id: row.tofuKeyId,
    declared_capabilities: JSON.parse(row.declaredCapabilities) as string[],
    registered_at: row.registeredAt,
    created,
  };
}
