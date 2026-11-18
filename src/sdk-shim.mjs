/**
 * Placeholder AI-SDK provider factory for OpenCode >= 2.2.0.
 *
 * OpenCode's built-in DynamicProviderPlugin is registered before user plugins.
 * For an `aisdk:*` provider it runs `loadSDKFactory()` first and looks for a
 * `create*` export in the provider package. Pointing PROVIDER_PACKAGE at this
 * local file satisfies that loader; the real SDK is then supplied by
 * `ctx.aisdk.hook("sdk", ...)` in src/index.ts.
 */
export function createAntigravity() {
  return {
    languageModel() {
      throw new Error("placeholder SDK - replaced by the opencode-antigravity plugin")
    },
  }
}
