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
