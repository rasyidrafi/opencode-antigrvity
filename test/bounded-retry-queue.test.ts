import { expect, test } from "bun:test";
import { BoundedRetryQueue } from "../src/bounded-retry-queue.js";

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Queue work did not complete before its test deadline");
    await Bun.sleep(5);
  }
}

test("deletion backlog has bounded concurrency, deduplicates, retries and resumes after restart", async () => {
  const backlog = new Set(Array.from({ length: 12 }, (_, index) => `host-${index}`));
  const cleaned = new Set<string>();
  let active = 0;
  let maximumActive = 0;
  let failFirstAttempt = true;
  let attempts = 0;
  const run = (failFirst: boolean) => new BoundedRetryQueue<string>(async host => {
    active++;
    attempts++;
    maximumActive = Math.max(maximumActive, active);
    try {
      await Bun.sleep(10);
      if (host === "host-0" && failFirst && failFirstAttempt) {
        failFirstAttempt = false;
        throw new Error("simulated busy host turn");
      }
      cleaned.add(host);
      backlog.delete(host);
    } finally { active--; }
  }, { concurrency: 3, retryDelayMs: failFirst ? 5000 : 20 });

  const first = run(true);
  for (const host of backlog) { first.enqueue(host); first.enqueue(host); }
  await waitFor(() => active === 0 && backlog.size === 1);
  first.close();
  await first.drain();
  expect(backlog).toEqual(new Set(["host-0"]));
  expect(maximumActive).toBeLessThanOrEqual(3);

  // A fresh plugin instance rebuilds its in-memory queue from durable pending
  // tombstones. Successful cleanup removes those tombstones from the source.
  const restarted = run(false);
  for (const host of backlog) restarted.enqueue(host);
  await waitFor(() => backlog.size === 0);
  restarted.close();
  await restarted.drain();
  expect(cleaned.size).toBe(12);
  expect(attempts).toBe(13);
  expect(maximumActive).toBeLessThanOrEqual(3);
});

test("a deleted-session event stays queued when its first tombstone write fails", async () => {
  let attempts = 0;
  let cleaned = false;
  const queue = new BoundedRetryQueue<string>(async host => {
    attempts++;
    // Mirrors the first operation in the plugin's deleted-session work item.
    if (attempts === 1) throw new Error("transient tombstone write failure");
    expect(host).toBe("event-host");
    cleaned = true;
  }, { concurrency: 1, retryDelayMs: 20 });

  try {
    await queue.enqueue("event-host");
    expect(attempts).toBe(1);
    expect(cleaned).toBe(false);
    await waitFor(() => cleaned);
    expect(attempts).toBe(2);
  } finally {
    queue.close();
    await queue.drain();
  }
});
