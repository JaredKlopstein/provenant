/**
 * POST /api/account/portal: opens the Stripe billing portal for the signed-in
 * customer. The logic lives in src/portal.ts so tests can inject Stripe and the
 * database; the deployed route passes nothing and reads process.env on each request.
 */
import { createPortalRoute } from '../../../../src/portal';

export const POST = createPortalRoute();
