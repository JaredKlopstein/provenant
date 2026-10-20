/**
 * POST /api/checkout: starts a Stripe Checkout session for the signed-in customer.
 * The logic lives in src/checkout.ts so tests can inject Stripe and the database;
 * the deployed route passes nothing and reads process.env on each request.
 */
import { createCheckoutRoute } from '../../../src/checkout';

export const POST = createCheckoutRoute();
