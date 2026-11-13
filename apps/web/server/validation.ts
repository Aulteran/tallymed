import { z } from 'zod';
import { AppError } from './errors.ts';
import { MAX_PASSWORD_LENGTH } from './passwords.ts';

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const displayName = z.string().trim().min(1).max(80);
const password = z.string().max(MAX_PASSWORD_LENGTH + 1); // policy is applied by the service
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const uuid = z.uuid();
const role = z.enum(['admin', 'operator']);

export const schemas = {
  login: z.strictObject({ email, password: z.string().min(1).max(MAX_PASSWORD_LENGTH) }),
  logout: z.strictObject({ csrf: z.string().optional() }),
  invite: z.strictObject({ email, role, csrf: z.string().optional() }),
  revokeInvitation: z.strictObject({ invitationId: uuid, csrf: z.string().optional() }),
  accept: z.strictObject({ token, displayName, password }),
  updateOperator: z.strictObject({
    userId: uuid,
    version: z.coerce.number().int().min(1),
    role,
    status: z.enum(['active', 'disabled']),
    csrf: z.string().optional(),
  }),
  bootstrap: z.strictObject({ householdName: z.string().trim().min(1).max(120), email, displayName, password }),
};

export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError('invalid_input');
  return result.data;
}
