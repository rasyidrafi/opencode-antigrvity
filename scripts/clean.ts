import { $ } from "bun";

// Bun Shell's rm builtin has the same behavior on Windows, macOS, and Linux.
await $`rm -rf dist`;
