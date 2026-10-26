import { z } from 'zod';
import { BUREAUS } from './disputes';

export const credentialsSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(128),
});

export const newDisputeSchema = z.object({
  clientId: z.string().uuid(),
  tradelineId: z.string().uuid(),
  bureau: z.enum(BUREAUS),
  reason: z.string().trim().min(10, 'Please describe the inaccuracy').max(2000),
});

export type NewDispute = z.infer<typeof newDisputeSchema>;

export const signUpSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(10).max(128),
  fullName: z.string().trim().min(1).max(120),
  mode: z.enum(['personal', 'agency']),
  orgName: z.string().trim().max(120).optional(),
});

export const mfaCodeSchema = z.string().regex(/^\d{6}$/);

export const newClientSchema = z.object({
  fullName: z.string().trim().min(1).max(120),
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  phone: z.string().trim().max(30).optional(),
});
