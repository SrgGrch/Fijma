// Execution budgets are independent of the existing batch/export negotiation.
export const executionLimits = {
  maxCodeBytes: 32768, maxArgsBytes: 8192, maxResultBytes: 262144,
  maxLogBytes: 8192, maxLogEntries: 100, maxDepth: 32, maxValues: 10000,
  maxResources: 16, maxResourceBytes: 4194304, resourceTtl: 60000,
} as const;
