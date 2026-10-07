/** Execution, reader and retention share one cross-process host identity. */
export function ownershipKey(key: string, hostSessionID?: string): string {
  return hostSessionID ? `host:${hostSessionID}` : key;
}
