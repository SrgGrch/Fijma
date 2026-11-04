import { z } from 'zod';

export const pairingSecret = z.string().regex(/^[0-9a-f]{64}$/);
export const pairingRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('pairing-load') }),
  z.strictObject({ type: z.literal('pairing-save'), secret: pairingSecret }),
  z.strictObject({ type: z.literal('pairing-forget') }),
]);
export const pairingReplySchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('pairing-loaded'), secret: pairingSecret.optional() }),
  z.strictObject({ type: z.literal('pairing-saved') }),
  z.strictObject({ type: z.literal('pairing-forgotten') }),
  z.strictObject({ type: z.literal('pairing-error'), action: z.enum(['load', 'save', 'forget']) }),
]);
