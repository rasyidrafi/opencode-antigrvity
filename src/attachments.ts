/**
 * Media policy for the official Antigravity ACP server. ACP carries binary
 * prompts as base64 content blocks; remote URLs are deliberately not fetched
 * by the local adapter.
 */
export const AGY_ATTACHMENT_POLICY = {
  acceptedInputParts: ["text", "input_text", "image_url", "input_image", "image", "audio", "file", "input_file"] as const,
  rejectedInputParts: ["video", "pdf", "document", "remote_url"] as const,
  materialization: "base64-or-local-file",
  remoteUrls: "not-forwarded",
} as const;

export function attachmentPolicyExplanation(): string {
  return [
    "The official Antigravity ACP server accepts text, image, and audio content blocks.",
    "Local image/audio files are read and encoded as ACP blocks; remote URLs are not fetched.",
    "PDF and video blocks remain unsupported until the ACP server advertises those prompt capabilities.",
  ].join(" ");
}
