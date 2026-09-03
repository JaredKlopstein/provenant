/**
 * Side-effecting module: registers the commercial actions and anchor backends
 * into core's registry. Imported by the cloud CLI and by tests that need the
 * paid surface.
 */
import { registerAnchorBackend } from '@provenant/core';
import { createTsaBackend, PUBLIC_TSAS } from './anchor/tsa.js';
import './actions/bundle.js';

/**
 * Configure the timestamp authority from the environment so an operator can
 * point at their own without a code change.
 *   PROVENANT_TSA_URL  -- full URL, or one of: freetsa, digicert, sectigo
 */
const configured = process.env.PROVENANT_TSA_URL ?? 'digicert';
const url = (PUBLIC_TSAS as Record<string, string>)[configured] ?? configured;

registerAnchorBackend(createTsaBackend({ url }));
