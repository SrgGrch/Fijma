import { z } from 'zod';

export function safeError(error: { code: string; details?: unknown }, secret: string) {
  const modeLimit = error.code === 'CAPABILITY_UNAVAILABLE' && z.strictObject({ reason: z.literal('VARIABLE_MODE_LIMIT') }).safeParse(error.details).success;
  if (modeLimit) return { code: error.code, message: 'The editor cannot add another variable mode.', recoveryAction: 'Use an existing mode or check the editor limits.', details: { reason: 'VARIABLE_MODE_LIMIT' as const } };
  const fonts = z.strictObject({ fonts: z.array(z.strictObject({ family: z.string().min(1).max(200), style: z.string().min(1).max(200) })).max(100) }).safeParse(error.details);
  const details = error.code === 'FONT_UNAVAILABLE' && fonts.success && !JSON.stringify(fonts.data).includes(secret) ? { details: fonts.data } : {};
  return { code: error.code, message: 'Operation in Figma failed.', recoveryAction: 'Check the error code and reread the context.', ...details };
}
