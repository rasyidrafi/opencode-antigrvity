import { Rpc } from "@opencode/plugin/rpc";

export const snapshotSchema = {
  type: "object",
  properties: {
    version: { type: "integer", const: 1 }, hostSessionID: { type: "string", minLength: 1 },
    epoch: { type: "integer", minimum: 0 }, sequence: { type: "integer", minimum: 0 },
    state: { type: "string", enum: ["measured", "unknown", "stale"] },
    sourceSessionID: { type: "string" }, model: { type: "string" }, requestedModel: { type: "string" }, baseline: { type: "string" },
    executionGeneration: { type: "string" },
    observedAt: { type: "number", minimum: 0 }, used: { type: "number", minimum: 0 }, size: { type: "number", exclusiveMinimum: 0 },
  },
  required: ["version", "hostSessionID", "epoch", "sequence", "state"], additionalProperties: false,
} as const;

export const ContextTelemetry = Rpc.define({
  id: "antigravity-context-v1",
  methods: {
    read: {
      input: { type: "object", properties: { sessionID: { type: "string", minLength: 1 } }, required: ["sessionID"], additionalProperties: false },
      output: snapshotSchema,
      errors: { wrong_location: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"], additionalProperties: false } },
    },
  },
  events: { changed: { schema: snapshotSchema } },
});
