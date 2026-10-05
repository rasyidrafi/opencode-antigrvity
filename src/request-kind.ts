import { extractTextContent, type HostMessage } from "./prompt.js";

export type MetaRequestKind = "title" | "summary" | "generate" | null;

export function metaSystemPrompt(messages: HostMessage[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => extractTextContent(message.content))
    .join("\n")
    .toLowerCase();
}

export function isTitleGenerationRequest(messages: HostMessage[]): boolean {
  const system = metaSystemPrompt(messages);
  return system.includes("title generator") ||
    system.includes("generate a short title") ||
    system.includes("generate a brief title") ||
    system.includes("output only a thread title");
}

export function isSummaryGenerationRequest(messages: HostMessage[]): boolean {
  const system = metaSystemPrompt(messages);
  if (system.includes("anchored context summarization") ||
    system.includes("summarizing, compacting, or merging context") ||
    system.includes("tasked with summarizing conversations") ||
    system.includes("write like a pull request description") ||
    system.includes("summarize what was done in this conversation")) return true;
  return false;
}

export function detectMetaRequestKind(messages: HostMessage[], explicitKind?: string): MetaRequestKind {
  if (explicitKind === "chat") return null;
  if (explicitKind === "title") return "title";
  if (explicitKind === "summary" || explicitKind === "compaction") return "summary";
  if (explicitKind === "generate") return "generate";
  if (isTitleGenerationRequest(messages)) return "title";
  if (isSummaryGenerationRequest(messages)) return "summary";
  return null;
}
