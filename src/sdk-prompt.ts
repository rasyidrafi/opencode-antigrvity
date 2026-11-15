import type {
  LanguageModelV3FilePart,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3ToolResultOutput,
} from "@ai-sdk/provider";
import { UnsupportedMediaError } from "./errors.js";
import type { HostMessage, MessageContentPart } from "./prompt.js";

/**
 * Translate OpenCode's AI SDK prompt into the adapter's internal message shape.
 *
 * The session pool, host tool bridge and reconstruction logic all speak the
 * compact Anthropic-style shape that the previous HTTP adapter used. Keeping
 * that shape lets the LanguageModelV3 boundary stay a translation layer: no
 * wire protocol, no loopback server. The system message is dropped for primary
 * requests because the agent system travels separately in provider options.
 */

function textPart(text: string): MessageContentPart {
  return { type: "text", text };
}

function imagePart(part: LanguageModelV3FilePart): MessageContentPart {
  const mediaType = part.mediaType.toLowerCase();
  if (!mediaType.startsWith("image/")) throw new UnsupportedMediaError(part.mediaType);
  let data: string;
  if (typeof part.data === "string") {
    const match = /^data:([^;,]+)?(?:;[^;,]*)*;base64,(.+)$/is.exec(part.data.trim());
    if (match) return { type: "image", source: { type: "base64", media_type: match[1] || part.mediaType, data: match[2] } };
    data = part.data;
  } else if (part.data instanceof Uint8Array) {
    data = Buffer.from(part.data).toString("base64");
  } else {
    throw new UnsupportedMediaError("remote_url");
  }
  return { type: "image", source: { type: "base64", media_type: mediaType, data } };
}

function userParts(content: LanguageModelV3Message & { role: "user" }): MessageContentPart[] {
  const parts: MessageContentPart[] = [];
  for (const part of content.content) {
    if (part.type === "text") parts.push(textPart(part.text));
    else if (part.type === "file") parts.push(imagePart(part));
  }
  return parts;
}

function assistantParts(content: LanguageModelV3Message & { role: "assistant" }): MessageContentPart[] {
  const parts: MessageContentPart[] = [];
  for (const part of content.content) {
    if (part.type === "text") parts.push(textPart(part.text));
    else if (part.type === "reasoning") parts.push({ type: "thinking", thinking: part.text });
    else if (part.type === "tool-call") parts.push({ type: "tool_use", id: part.toolCallId, name: part.toolName, input: part.input });
    else if (part.type === "file") parts.push(imagePart(part));
    else if (part.type === "tool-result") {
      const result = toolResultParts(part.output);
      parts.push({ type: "tool_result", tool_use_id: part.toolCallId, content: result.content, ...(result.isError ? { is_error: true } : {}) });
    }
  }
  return parts;
}

function toolResultParts(output: LanguageModelV3ToolResultOutput): { content: MessageContentPart[]; isError: boolean } {
  switch (output.type) {
    case "text":
      return { content: [textPart(output.value)], isError: false };
    case "json":
      return { content: [textPart(JSON.stringify(output.value))], isError: false };
    case "error-text":
      return { content: [textPart(output.value)], isError: true };
    case "error-json":
      return { content: [textPart(JSON.stringify(output.value))], isError: true };
    case "execution-denied":
      return { content: [textPart(output.reason ?? "Tool execution was denied.")], isError: true };
    case "content": {
      const content: MessageContentPart[] = [];
      for (const item of output.value) {
        if (item.type === "text") {
          content.push(textPart(item.text));
          continue;
        }
        if (item.type === "image-data") {
          if (!item.mediaType.toLowerCase().startsWith("image/")) throw new UnsupportedMediaError(item.mediaType);
          content.push({ type: "image", source: { type: "base64", media_type: item.mediaType, data: item.data } });
          continue;
        }
        throw new UnsupportedMediaError(item.type);
      }
      return { content, isError: false };
    }
    default:
      throw new UnsupportedMediaError("unknown_tool_result");
  }
}

function toolMessage(content: LanguageModelV3Message & { role: "tool" }): HostMessage {
  const parts: MessageContentPart[] = [];
  for (const part of content.content) {
    if (part.type === "tool-result") {
      const result = toolResultParts(part.output);
      parts.push({ type: "tool_result", tool_use_id: part.toolCallId, content: result.content, ...(result.isError ? { is_error: true } : {}) });
      continue;
    }
    throw new UnsupportedMediaError("tool_approval_response");
  }
  return { role: "user", content: parts };
}

export function sdkPromptToHostMessages(
  prompt: LanguageModelV3Prompt,
  options: { includeSystem?: boolean } = {},
): HostMessage[] {
  const messages: HostMessage[] = [];
  for (const message of prompt) {
    if (message.role === "system") {
      // Primary requests carry the agent system in provider options instead;
      // utility requests keep the assembled system as quoted context.
      if (options.includeSystem) messages.push({ role: "system", content: message.content });
      continue;
    }
    if (message.role === "user") {
      // The AI SDK type is an array; tolerate a bare string from callers.
      if (typeof (message.content as unknown) === "string") {
        const text = message.content as unknown as string;
        messages.push({ role: "user", content: text ? [textPart(text)] : [] });
      } else {
        messages.push({ role: "user", content: userParts(message) });
      }
    } else if (message.role === "assistant") messages.push({ role: "assistant", content: assistantParts(message) });
    else if (message.role === "tool") messages.push(toolMessage(message));
  }
  return messages;
}
