import { describe, expect, it } from "vitest";
import { BUILTIN_POLICY, parsePluginConfig, resolveModelPolicy } from "./config.js";
import { resolveTransport } from "./transport.js";

describe("plugin policy resolution", () => {
  it("uses safe built-ins when config is absent", () => {
    const policy = resolveModelPolicy({}, "glm-5.3-flash");
    expect(policy).toEqual(BUILTIN_POLICY);
    expect(policy.transport).toBe("auto");
    expect(policy.trust.mode).toBe("key-default");
    expect(policy.teeVerification.enabled).toBe(false);
  });

  it("merges global defaults and per-model overrides", () => {
    const config = parsePluginConfig({
      defaults: {
        routing: { enabled: true, sort: "latency", allowFallbacks: true },
        observability: { enabled: false },
      },
      models: {
        "glm-5.3": {
          transport: "responses",
          trust: { mode: "private", allowDowngrade: false },
          teeVerification: { required: true },
        },
      },
    });
    const policy = resolveModelPolicy(config, "glm-5.3");
    expect(policy.transport).toBe("responses");
    expect(policy.routing.sort).toBe("latency");
    expect(policy.observability.enabled).toBe(false);
    expect(policy.trust.mode).toBe("private");
    expect(policy.teeVerification).toEqual({ enabled: true, required: true });
  });

  it("normalizes model ids for overrides and transport selection", () => {
    const config = parsePluginConfig({ models: { "GLM-5.3-FLASH": { transport: "responses" } } });
    expect(resolveModelPolicy(config, "glm-5.3-flash").transport).toBe("responses");
    expect(resolveTransport("GLM-5.3-FLASH", "auto").transport).toBe("chat-completions");
  });

  it("lets a model opt out of global defaults", () => {
    const config = parsePluginConfig({
      defaults: {
        transport: "responses",
        routing: { enabled: false },
      },
      models: {
        "glm-5.3-flash": {
          inheritDefaults: false,
          transport: "messages",
        },
      },
    });
    const policy = resolveModelPolicy(config, "glm-5.3-flash");
    expect(policy.transport).toBe("messages");
    expect(policy.routing.enabled).toBe(false);
    expect(policy.routing.sort).toBeUndefined();
  });
});

describe("transport manager", () => {
  it("chooses model-native defaults in auto mode", () => {
    expect(resolveTransport("claude-haiku-5.5", "auto").transport).toBe("messages");
    expect(resolveTransport("deepseek-v4.1-flash", "auto").transport).toBe("chat-completions");
    expect(resolveTransport("qwen3.7-flash", "auto").transport).toBe("chat-completions");
    expect(resolveTransport("glm-5.3-flash", "auto").transport).toBe("chat-completions");
    expect(resolveTransport("glm-5.3", "auto").transport).toBe("chat-completions");
  });

  it("allows any explicitly advertised transport", () => {
    expect(resolveTransport("glm-5.3-flash", "messages", ["openai", "anthropic", "responses"]).api).toBe("anthropic-messages");
    expect(resolveTransport("glm-5.3-flash", "responses", ["openai", "anthropic", "responses"]).api).toBe("openai-responses");
  });

  it("fails closed when an explicit transport is not advertised", () => {
    expect(() => resolveTransport("deepseek-v4.1-flash", "messages", ["openai", "responses"])).toThrow(/not advertised/);
  });
});
