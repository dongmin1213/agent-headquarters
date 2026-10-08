// Transport errors must not become product failures or consume repair/model escalation budgets.
export function transientTransport(error: unknown): boolean {
  return typeof error === 'string' && /workspace routing discovery failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network (?:is )?unreachable|fetch failed|stream disconnected|connection (?:reset|closed)|\b(?:502|503|504)\b/i.test(error)
}
