import { pairingRequestSchema, pairingSecret } from '../shared/pairing';

export function createPairingStorage() {
  const key = 'bridge-pairing-v1';
  let pending = Promise.resolve();
  return (raw: unknown) => {
    if (!raw || typeof raw !== 'object' || !('type' in raw) ||
      !['pairing-load', 'pairing-save', 'pairing-forget'].includes(raw.type as string)) return false;
    const parsed = pairingRequestSchema.safeParse(raw);
    if (!parsed.success) return true;
    const message = parsed.data;
    // Serialize reads and writes so Forget cannot be undone by an earlier Save.
    pending = pending.then(async () => {
      try {
        if (message.type === 'pairing-load') {
          const saved = pairingSecret.safeParse(await figma.clientStorage.getAsync(key));
          figma.ui.postMessage({ type: 'pairing-loaded', ...(saved.success ? { secret: saved.data } : {}) });
        } else if (message.type === 'pairing-save') {
          await figma.clientStorage.setAsync(key, message.secret);
          figma.ui.postMessage({ type: 'pairing-saved' });
        } else {
          await figma.clientStorage.deleteAsync(key);
          figma.ui.postMessage({ type: 'pairing-forgotten' });
        }
      } catch { figma.ui.postMessage({ type: 'pairing-error', action: message.type.slice(8) }); }
    });
    return true;
  };
}
