export function createUIYield(post: (message: { type: 'yield'; id: number }) => void) {
  let sequence = 0;
  let pending: { id: number; resolve: () => void } | undefined;
  return {
    wait: () => new Promise<void>(resolve => {
      if (pending) throw new Error('RESOURCE_LIMIT');
      pending = { id: ++sequence, resolve };
      post({ type: 'yield', id: sequence });
    }),
    accept(message: unknown) {
      if (!message || typeof message !== 'object') return false;
      const value = message as { type?: string; id?: number };
      if (value.type !== 'yield' || Object.keys(value).length !== 2 || !pending || value.id !== pending.id) return false;
      const { resolve } = pending; pending = undefined; resolve();
      return true;
    },
    release() { const current = pending; pending = undefined; current?.resolve(); },
  };
}
