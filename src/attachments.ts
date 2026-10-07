import type { ContentBlock } from "@agentclientprotocol/sdk";
import { AgyAbortError, AgyError } from "./errors.js";

export const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;
export const MAX_MEDIA_BYTES = 32 * 1024 * 1024;
/** Advisory context occupancy only; never billing or a tokenizer measurement. */
export const IMAGE_CONTEXT_ESTIMATE = 4096;
export type MediaMaterializationBudget = { remaining: number; signal?: AbortSignal; inspect?: boolean };
// Inspection retains only metadata for local files, not their encoded contents.
const deferredImages = new WeakMap<ContentBlock, { bytes: number; load: (budget: MediaMaterializationBudget) => Promise<ContentBlock> }>();
export function deferredImage(mimeType: string, bytes: number, load: (budget: MediaMaterializationBudget) => Promise<ContentBlock>): ContentBlock {
  const block: ContentBlock = { type: "image", data: "", mimeType };
  deferredImages.set(block, { bytes, load });
  return block;
}
export async function materializeMedia(blocks: ContentBlock[], signal?: AbortSignal): Promise<ContentBlock[]> {
  validateMediaBlocks(blocks);
  const budget = { remaining: MAX_MEDIA_BYTES, signal };
  const result: ContentBlock[] = [];
  for (const block of blocks) {
    if (signal?.aborted) throw new AgyAbortError();
    const deferred = deferredImages.get(block);
    if (deferred) result.push(await deferred.load(budget));
    else { if (block.type === "image") reserveMedia(budget, mediaBytes(block.data)); result.push(block); }
  }
  validateMediaBlocks(result);
  return result;
}
export function reserveMedia(budget: MediaMaterializationBudget, bytes: number): void {
  if (bytes > budget.remaining) throw new AgyError("invalid_request", "The combined images are too large", { code: "agy_attachments_too_large" });
  budget.remaining -= bytes;
}

export function mediaBytes(data: string): number {
  // Bound length before scanning or decoding. No decoded copy is needed.
  if (data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) throw new AgyError("invalid_request", "The image is too large", { code: "agy_attachment_too_large" });
  if (!data.length || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new AgyError("invalid_request", "Invalid base64 image", { code: "agy_attachment_invalid_base64" });
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if ((padding === 2 && (alphabet.indexOf(data.at(-3)!) & 15)) || (padding === 1 && (alphabet.indexOf(data.at(-2)!) & 3))) throw new AgyError("invalid_request", "Invalid base64 image padding", { code: "agy_attachment_invalid_base64" });
  const bytes = data.length / 4 * 3 - padding;
  if (bytes > MAX_ATTACHMENT_BYTES) throw new AgyError("invalid_request", "The image is too large", { code: "agy_attachment_too_large" });
  return bytes;
}

export function validateMediaBlocks(blocks: ContentBlock[], limit = MAX_MEDIA_BYTES): number {
  let bytes = 0;
  for (const block of blocks) if (block.type === "image") {
    bytes += deferredImages.get(block)?.bytes ?? mediaBytes(block.data);
    if (bytes > limit) throw new AgyError("invalid_request", "The combined images are too large", { code: "agy_attachments_too_large" });
  }
  return bytes;
}

/**
 * Media policy for the official Antigravity server. ACP carries binary
 * prompts as base64 content blocks; remote URLs are deliberately not fetched
 * by the local adapter.
 */
export const AGY_ATTACHMENT_POLICY = {
  acceptedInputParts: ["text", "input_text", "image_url", "input_image", "image"] as const,
  rejectedInputParts: ["audio", "input_audio", "file", "input_file", "video", "pdf", "document", "remote_url"] as const,
  materialization: "base64-or-local-file",
  remoteUrls: "not-forwarded",
} as const;

export function attachmentPolicyExplanation(): string {
  return [
    "This adapter supports text and image input and text output.",
    "Local images are read and encoded as ACP blocks; remote URLs are not fetched.",
    "Audio, file/document, PDF and video blocks are explicitly unsupported.",
  ].join(" ");
}
