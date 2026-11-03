// Provisional bootstrap values; document capabilities remain disabled pending task 1.6.
export const bootstrapLimits = {
  maxMessageBytes: 65536, maxBatchSteps: 1, maxQueuedOperations: 1,
  maxDepth: 8, maxNodes: 1000, maxResponseBytes: 32768,
  maxImportBytes: 262144, maxExportPixels: 1000000, maxExportBytes: 262144,
  operationTimeout: 30000, dedupTtl: 60000, maxJournalEntries: 100, resourceTtl: 60000, clockSkew: 5000,
};
