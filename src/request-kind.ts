export type MetaRequestKind = "title" | "compaction" | "generate" | null;

export function detectMetaRequestKind(kind?: string): MetaRequestKind {
  return kind === "title" || kind === "compaction" || kind === "generate" ? kind : null;
}
