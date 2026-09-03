/** Provenant Core -- MIT. Receipts, chaining, identity, local verification. */
export { canonicalize, canonicalBytes, CanonicalizationError } from './canonical/jcs.js';
export { hashJson, sha256Hex, toHex, fromHex, toBase64Url, fromBase64Url } from './crypto/hash.js';
export {
  generateKeypair, fromSecretKey, publicKeyToJwk, jwkToPublicKey, jwkThumbprint,
  deriveAgentId, fingerprint, sign, verify, SIGNATURE_ALG,
  type Keypair, type AgentJwk,
} from './crypto/keys.js';
export {
  Receipt, UnsignedReceipt, ActionType, Outcome, TrustLevel, SideEffectClass,
  AAT_DRAFT_VERSION, PROVENANT_RECEIPT_VERSION,
} from './receipt/schema.js';
export {
  signReceipt, verifyReceiptSignature, receiptHash, canonicalReceiptJson,
  signingPreimage, payloadHash, stripUndefined,
} from './receipt/hash.js';
export { appendReceipt, readHead, nowRfc3339, type AppendInput, type AppendResult } from './chain/append.js';
export {
  verifyChain, type VerifyResult, type ChainFailure, type VerifiableRecord, type KeyDirectory,
} from './chain/verify.js';
export { openDb, closeDb, type Db } from './db/client.js';
export * as dbSchema from './db/schema.js';
export {
  registerAgent, getAgent, requireAgent, listAgents, keyDirectory, type RegisteredAgent,
} from './agents/store.js';
export {
  agentReliability, receiptCounts, type AgentReliability, type DerivedRate,
} from './agents/reliability.js';
export { ProvenantError, toProvenantError, ERROR_CODES, type ErrorCode } from './errors.js';
export {
  registerAnchorBackend, getAnchorBackend, anchorBackendNames,
  type AnchorBackend, type AnchorProof, type AnchorStatement, type AnchorRecord, type AnchorProofType,
} from './anchor/types.js';
export { noopBackend } from './anchor/noop.js';
export {
  createAnchor, listAnchors, anchorCovering, buildStatement, anchorImprint,
  imprintHex, chainId, toAnchorRecord,
} from './anchor/store.js';
export { resolveStoreDir, dbPath, keyPath } from './config.js';
export {
  signRequest, verifyRequest, signatureBase, serializeParams, contentDigest,
  NonceCache, keyDirectoryDocument, REQUIRED_COMPONENTS,
  MAX_REPLAY_WINDOW_SECONDS, MAX_EXPIRY_SECONDS,
  type RequestLike, type SignatureParams, type SignedHeaders,
  type VerifyResult as SignatureVerifyResult, type VerifyRequestOptions,
} from './http/signatures.js';
export { defineAction, allActions, getAction, actionNames } from './registry/registry.js';
export { buildManifest } from './registry/discover.js';
export type { ActionDef, ActionContext, ActionDescription, NextAction } from './registry/types.js';
export { runCli } from './adapters/cli.js';
export { loadKeypair, saveKeypair } from './actions/identity.js';

// Importing these registers them in the action registry.
import './actions/identity.js';
import './actions/record.js';
import './actions/chain.js';
import './actions/anchor.js';
