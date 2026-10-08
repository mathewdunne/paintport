/**
 * Asks the browser not to evict our IndexedDB data under storage pressure. Best effort: the
 * browser may say no or ask the user, and a missing API or a failure changes nothing. Asked once.
 */
let asked = false;
export async function requestPersistentStorage(storage: { persist?: () => Promise<boolean> } | undefined = globalThis.navigator?.storage): Promise<boolean> {
  if (asked) return false;
  asked = true;
  try {
    return (await storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

/** For tests. */
export function resetPersistentStorageRequest(): void {
  asked = false;
}
