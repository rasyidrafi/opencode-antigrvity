import { resolve } from "node:path";

export class WorkspaceRegistry {
  private readonly roots = new Set<string>();
  private readonly pending = new Map<string, Promise<void>>();
  private closing = false;
  private cleanupPromise?: Promise<void>;

  constructor(
    private readonly retain: (directory: string) => Promise<unknown>,
    private readonly release: (directory: string) => Promise<void>,
  ) {}

  add(directory: string): Promise<void> {
    const root = resolve(directory);
    if (this.closing) return Promise.reject(new Error("Workspace registry is closing"));
    if (this.roots.has(root)) return Promise.resolve();
    const pending = this.pending.get(root);
    if (pending) return pending;

    const registration = Promise.resolve()
      .then(() => this.retain(root))
      .then(() => { this.roots.add(root); })
      .finally(() => { this.pending.delete(root); });
    this.pending.set(root, registration);
    return registration;
  }

  cleanup(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.closing = true;
    this.cleanupPromise = (async () => {
      await Promise.allSettled(this.pending.values());
      const roots = [...this.roots];
      this.roots.clear();
      const results = await Promise.allSettled(roots.map((root) => Promise.resolve().then(() => this.release(root))));
      const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, "Failed to release all registered workspaces");
    })();
    return this.cleanupPromise;
  }
}
