/**
 * Media policy for the official Antigravity ACP server. ACP carries binary
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
