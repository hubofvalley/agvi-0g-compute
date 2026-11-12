import {
  definePluginEntry,
  type ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import {
  parsePluginConfig,
  resolveModelPolicy,
  type ModelPolicy,
  type ZeroGPluginConfig,
} from "./config.js";
import {
  discoverModel,
  discoverModelSWR,
  discoverModels,
  discoverProviders,
  type RemoteModelCapability,
  type RemoteProviderCapability,
} from "./discovery.js";
import { buildModelCatalog, buildModelFromRemote, getModelMetadata, MODEL_CATALOG } from "./catalog.js";
import { MODEL_IDS, normalizeModelId, PROVIDER_ID, ROUTER_BASE_URL } from "./identifiers.js";
import { resolveTransport, type ResolvedTransport } from "./transport.js";

export { MODEL_CATALOG };

/**
 * AGVI's first-party, direct connection to the 0G Compute Router.
 * Keep model metadata on this provider, not on a local proxy.
 * Haiku uses the native Anthropic Messages adapter to avoid the OpenAI SSE
 * translation that repeatedly failed in local subagent sessions.
 */
const PROVIDER = PROVIDER_ID;
const HAIKU = MODEL_IDS.HAIKU;
const PINNED_PROVIDER_FALLBACK_PREFIX = "0G pinned provider fallback";
const CIRCUIT_OPEN_ERROR_PREFIX = "0G route temporarily quarantined after repeated stalled streams";

/**
 * Provider transport request budget. This does NOT replace OpenClaw's generic
 * first-event/idle watchdog (currently 120s for ordinary cloud-model turns).
 * A request can therefore still be aborted by the host before this 180s budget.
 *
 * Explicit operator configuration still wins: normalizeConfig only supplies
 * this value when models.providers.agvi-0g-compute.timeoutSeconds is absent.
 */
export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 180;
export const DEFAULT_REQUEST_TIMEOUT_MS = DEFAULT_REQUEST_TIMEOUT_SECONDS * 1_000;

/** Keep provider/SDK Retry-After sleeps bounded; OpenClaw still owns model retries. */
export const DEFAULT_MAX_RETRY_DELAY_MS = 15_000;

/**
 * A small process-local breaker prevents a bad 0G route from consuming a long
 * subagent run as a sequence of identical silent requests. It does not alter
 * OpenClaw's subagent configuration or global retry policy.
 */
export const CIRCUIT_BREAKER_FAILURES = 2;
export const CIRCUIT_BREAKER_COOLDOWN_MS = 120_000;

type RouteHealth = {
  consecutiveStalls: number;
  openUntil: number;
};

const routeHealth = new Map<string, RouteHealth>();
type RuntimeLogger = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
};
let runtimeLogger: RuntimeLogger | undefined;
let runtimePluginConfig: ZeroGPluginConfig = {};

export function setPluginConfigForTests(raw: unknown): void {
  runtimePluginConfig = parsePluginConfig(raw);
}

function routeKey(modelId: string | undefined): string {
  return normalizeModelId(modelId);
}

function requiresCapabilityDiscovery(policy: ModelPolicy): boolean {
  return policy.capabilityDiscovery.enabled && (
    policy.trust.mode === "private" ||
    policy.teeVerification.required ||
    Boolean(policy.routing.address) ||
    Boolean(policy.routing.identity)
  );
}

function canDowngradePrivate(policy: ModelPolicy): boolean {
  return policy.trust.mode === "private" &&
    policy.trust.allowDowngrade &&
    !policy.teeVerification.required &&
    !policy.routing.address &&
    !policy.routing.identity;
}
function timeoutLike(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /(?:idle timeout|timed out|timeout|aborted due to timeout)/i.test(message);
}

function recordRouteProgress(modelId: string | undefined): void {
  const prior = routeHealth.get(routeKey(modelId));
  routeHealth.delete(routeKey(modelId));
  if (prior?.consecutiveStalls) {
    runtimeLogger?.info?.(`agvi-0g-compute route recovered model=${routeKey(modelId)} priorStalls=${prior.consecutiveStalls}`);
  }
}

function isProviderProgressEvent(event: { type?: string }): boolean {
  return event.type === "text_delta" ||
    event.type === "thinking_delta" ||
    event.type === "toolcall_delta" ||
    event.type === "text_end" ||
    event.type === "thinking_end" ||
    event.type === "toolcall_start" ||
    event.type === "toolcall_end" ||
    event.type === "done";
}

function recordRouteStall(modelId: string | undefined, now = Date.now()): void {
  const key = routeKey(modelId);
  const current = routeHealth.get(key) ?? { consecutiveStalls: 0, openUntil: 0 };
  const consecutiveStalls = current.consecutiveStalls + 1;
  routeHealth.set(key, {
    consecutiveStalls,
    openUntil: consecutiveStalls >= CIRCUIT_BREAKER_FAILURES ? now + CIRCUIT_BREAKER_COOLDOWN_MS : 0,
  });
  runtimeLogger?.warn?.(
    `agvi-0g-compute stalled stream model=${key} consecutive=${consecutiveStalls}` +
      (consecutiveStalls >= CIRCUIT_BREAKER_FAILURES ? ` circuitOpenMs=${CIRCUIT_BREAKER_COOLDOWN_MS}` : ""),
  );
}

export function resetRouteHealthForTests(): void {
  routeHealth.clear();
}

export function getRouteHealth(modelId: string, now = Date.now()): RouteHealth & { open: boolean } {
  const state = routeHealth.get(routeKey(modelId)) ?? { consecutiveStalls: 0, openUntil: 0 };
  return { ...state, open: state.openUntil > now };
}

function circuitOpenError(modelId: string, openUntil: number): Error {
  const retryAfterSeconds = Math.max(1, Math.ceil((openUntil - Date.now()) / 1_000));
  return new Error(
    `${CIRCUIT_OPEN_ERROR_PREFIX} for ${modelId}; retry after about ${retryAfterSeconds}s`,
  );
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function shortProvider(value: string | undefined): string {
  if (!value) return "-";
  return value.length > 22 ? `${value.slice(0, 10)}...${value.slice(-6)}` : value;
}

type RequestPolicy = {
  policy: ModelPolicy;
  transport: ResolvedTransport;
  trustMode: ModelPolicy["trust"]["mode"];
  teeEnabled: boolean;
  providers: RemoteProviderCapability[];
  remoteModel?: RemoteModelCapability;
};

async function resolveRequestPolicy(
  model: Parameters<NonNullable<ProviderWrapStreamFnContext["streamFn"]>>[0],
  options?: Parameters<NonNullable<ProviderWrapStreamFnContext["streamFn"]>>[2],
): Promise<RequestPolicy> {
  const policy = resolveModelPolicy(runtimePluginConfig, model.id);
  const strictDiscovery = requiresCapabilityDiscovery(policy);
  let remoteModel: RemoteModelCapability | undefined;
  if (policy.capabilityDiscovery.enabled) {
    if (strictDiscovery) {
      try {
        remoteModel = await discoverModel(model.id, policy.capabilityDiscovery);
      } catch (error) {
        if (!canDowngradePrivate(policy)) {
          throw new Error(`0G strict model discovery failed for ${model.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
        runtimeLogger?.warn?.(`agvi-0g-compute model discovery unavailable model=${routeKey(model.id)} error=${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      remoteModel = discoverModelSWR(model.id, policy.capabilityDiscovery, (error) => {
        runtimeLogger?.debug?.(`agvi-0g-compute background model discovery failed model=${routeKey(model.id)} error=${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  const transport = resolveTransport(model.id, policy.transport, remoteModel?.supported_formats, model.api);
  let trustMode = policy.trust.mode;
  let providers: RemoteProviderCapability[] = [];
  const needsProviderDiscovery = strictDiscovery;

  if (policy.routing.identity && !policy.routing.address) {
    throw new Error(`0G routing identity for ${model.id} requires routing.address`);
  }

  if (needsProviderDiscovery) {
    const apiKey = options?.apiKey?.trim();
    if (!apiKey) {
      if (canDowngradePrivate(policy)) {
        runtimeLogger?.warn?.(`agvi-0g-compute private discovery unavailable without request API key; downgrading model=${routeKey(model.id)} to key-default`);
        trustMode = "key-default";
      } else if (policy.trust.mode === "private" || policy.teeVerification.required || policy.routing.address || policy.routing.identity) {
        throw new Error(`0G capability discovery for ${model.id} requires the resolved request API key`);
      }
    } else {
      try {
        providers = await discoverProviders(model.id, apiKey, policy.capabilityDiscovery);
      } catch (error) {
        if (canDowngradePrivate(policy)) {
          runtimeLogger?.warn?.(`agvi-0g-compute private provider discovery failed; downgrading model=${routeKey(model.id)} to key-default`);
          trustMode = "key-default";
        } else if (policy.trust.mode === "private" || policy.teeVerification.required || policy.routing.address || policy.routing.identity) {
          throw new Error(`0G provider discovery failed for ${model.id}: ${error instanceof Error ? error.message : String(error)}`);
        } else {
          runtimeLogger?.warn?.(`agvi-0g-compute provider discovery unavailable model=${routeKey(model.id)}`);
        }
      }
    }
  }

  if (trustMode === "private" && needsProviderDiscovery) {
    const privateHealthy = providers.some((row) => row.trust_mode === "private" && row.is_healthy !== false);
    if (!privateHealthy) {
      if (canDowngradePrivate(policy)) {
        runtimeLogger?.warn?.(`agvi-0g-compute private route unavailable; downgrading model=${routeKey(model.id)} to key-default`);
        trustMode = "key-default";
      } else {
        throw new Error(`0G private trust mode unavailable for ${model.id}`);
      }
    }
  }

  if (policy.routing.enabled && policy.routing.address && providers.length) {
    const pinned = providers.find((row) =>
      row.address?.toLowerCase() === policy.routing.address?.toLowerCase() &&
      (!policy.routing.identity || row.provider_identity === policy.routing.identity)
    );
    if (!pinned) throw new Error(`0G pinned provider is not advertised for ${model.id}`);
    if (pinned.is_healthy === false && !policy.routing.allowFallbacks) {
      throw new Error(`0G pinned provider is unhealthy for ${model.id} and fallbacks are disabled`);
    }
  }

  let teeEnabled = policy.teeVerification.enabled;
  if (teeEnabled) {
    const teeCapable = getModelMetadata(model.id)?.teeCapable === true ||
      remoteModel?.tee_attested === true ||
      Boolean(remoteModel?.verifiability) ||
      providers.some((row) => row.tee_attested === true);
    if (!teeCapable) {
      if (policy.teeVerification.required) {
        throw new Error(`0G TEE verification required but ${model.id} is not currently TEE-capable`);
      }
      teeEnabled = false;
      runtimeLogger?.warn?.(`agvi-0g-compute TEE verification skipped; model is not TEE-capable model=${routeKey(model.id)}`);
    }
  }
  if (policy.teeVerification.required && trustMode !== "private") {
    throw new Error(`0G teeVerification.required for ${model.id} requires trust.mode=private`);
  }

  return { policy, transport, trustMode, teeEnabled, providers, remoteModel };
}

function observeProviderStream<T extends {
  result(): Promise<unknown>;
  [Symbol.asyncIterator](): AsyncIterator<any>;
}>(
  source: T,
  modelId: string,
  recordTimeoutOnce: (error: unknown) => void,
  cleanup: () => void,
): T {
  let progressRecorded = false;
  const markProgress = () => {
    if (progressRecorded) return;
    progressRecorded = true;
    recordRouteProgress(modelId);
  };
  const wrapped = {
    async result() {
      try {
        const result = await source.result();
        markProgress();
        return result;
      } catch (error) {
        recordTimeoutOnce(error);
        throw error;
      } finally {
        cleanup();
      }
    },
    async *[Symbol.asyncIterator]() {
      try {
        for await (const event of source as any) {
          if (isProviderProgressEvent(event)) markProgress();
          yield event;
        }
      } catch (error) {
        recordTimeoutOnce(error);
        throw error;
      } finally {
        cleanup();
      }
    },
  };
  return wrapped as unknown as T;
}

export function wrapZeroGProviderStream(ctx: ProviderWrapStreamFnContext) {
  const underlying = ctx.streamFn;
  if (!underlying) return;

  const wrapped = async (model: Parameters<typeof underlying>[0], context: Parameters<typeof underlying>[1], options?: Parameters<typeof underlying>[2]) => {
    const health = getRouteHealth(model.id);
    if (health.open) {
      runtimeLogger?.warn?.(`agvi-0g-compute circuit open model=${routeKey(model.id)} until=${health.openUntil}`);
      throw circuitOpenError(model.id, health.openUntil);
    }

    let failureRecorded = false;
    const startedAt = Date.now();
    const recordTimeoutOnce = (error: unknown) => {
      if (failureRecorded || !timeoutLike(error)) return;
      failureRecorded = true;
      recordRouteStall(model.id);
    };

    const sourceSignal = options?.signal;
    const onAbort = () => recordTimeoutOnce(sourceSignal?.reason);
    if (sourceSignal?.aborted) onAbort();
    else sourceSignal?.addEventListener("abort", onAbort, { once: true });

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      sourceSignal?.removeEventListener("abort", onAbort);
    };

    let requestPolicy: RequestPolicy;
    try {
      requestPolicy = await resolveRequestPolicy(model, options);
    } catch (error) {
      cleanup();
      throw error;
    }

    const effectiveModel = { ...model, api: requestPolicy.transport.api } as typeof model;
    const previousOnPayload = options?.onPayload;
    const previousOnResponse = options?.onResponse;

    const nextHeaders: Record<string, string> = { ...(options?.headers ?? {}) };
    if (requestPolicy.policy.routing.enabled) {
      const routing = requestPolicy.policy.routing;
      if (routing.address) nextHeaders["X-0G-Provider-Address"] = routing.address;
      if (routing.identity) nextHeaders["X-0G-Provider-Identity"] = routing.identity;
      if (routing.sort) nextHeaders["X-0G-Provider-Sort"] = routing.sort;
      nextHeaders["X-0G-Provider-Allow-Fallbacks"] = String(routing.allowFallbacks);
    }
    if (requestPolicy.trustMode === "verified" || requestPolicy.trustMode === "private") {
      nextHeaders["X-0G-Provider-Trust-Mode"] = requestPolicy.trustMode;
    }

    const nextOptions = {
      ...options,
      headers: nextHeaders,
      timeoutMs: options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      maxRetryDelayMs: Math.min(
        options?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
        DEFAULT_MAX_RETRY_DELAY_MS,
      ),
      onPayload: async (payload: unknown, payloadModel: Parameters<NonNullable<typeof previousOnPayload>>[1]) => {
        const prior = previousOnPayload ? await previousOnPayload(payload, payloadModel) : undefined;
        const base = prior === undefined ? payload : prior;
        if (!requestPolicy.teeEnabled || !base || typeof base !== "object" || Array.isArray(base)) return base;
        return { ...(base as Record<string, unknown>), verify_tee: true };
      },
      onResponse: async (...args: Parameters<NonNullable<typeof previousOnResponse>>) => {
        const [response] = args;
        const provider = headerValue(response.headers, "x-provider") ?? headerValue(response.headers, "x-0g-provider");
        const e2ee = headerValue(response.headers, "x-0g-e2ee");
        const pinnedAddress = requestPolicy.policy.routing.address;
        const fallback = Boolean(pinnedAddress && provider && pinnedAddress.toLowerCase() !== provider.toLowerCase());
        if (fallback && !requestPolicy.policy.routing.allowFallbacks) {
          cleanup();
          throw new Error(`${PINNED_PROVIDER_FALLBACK_PREFIX}: ${pinnedAddress} returned ${provider}`);
        }
        const selectedRows = provider
          ? requestPolicy.providers.filter((row) => row.address?.toLowerCase() === provider.toLowerCase())
          : [];
        const discoveredIdentities = [...new Set(selectedRows.map((row) => row.provider_identity).filter(Boolean))];
        const providerIdentity = requestPolicy.policy.routing.identity ??
          (discoveredIdentities.length === 1 ? discoveredIdentities[0] : undefined);
        const selectedTeeAttested = selectedRows.some((row) => row.tee_attested === true);
        if (requestPolicy.trustMode === "private" && e2ee?.toLowerCase() !== "sealed") {
          cleanup();
          throw new Error(`0G private route for ${model.id} did not return sealed E2EE`);
        }
        if (requestPolicy.policy.observability.enabled) {
          runtimeLogger?.info?.(
            `agvi-0g-compute response model=${routeKey(model.id)}` +
              ` transport=${requestPolicy.transport.transport}` +
              ` trust=${requestPolicy.trustMode}` +
              ` status=${String(response.status)}` +
              ` provider=${shortProvider(provider)}` +
              ` identity=${providerIdentity ?? "-"}` +
              ` e2ee=${e2ee ?? "-"}` +
              ` teeRequested=${String(requestPolicy.teeEnabled)}` +
              ` providerTeeAttested=${String(selectedTeeAttested)}` +
              ` fallback=${String(fallback)}` +
              ` headersMs=${Date.now() - startedAt}` +
              (options?.requestId ? ` requestId=${options.requestId}` : ""),
          );
        }
        if (previousOnResponse) await previousOnResponse(response, effectiveModel);
      },
    };

    try {
      const stream = await underlying(effectiveModel, context, nextOptions);
      return observeProviderStream(stream, model.id, recordTimeoutOnce, cleanup);
    } catch (error) {
      recordTimeoutOnce(error);
      cleanup();
      throw error;
    }
  };

  // We only add provider policy around the generic transport. Keep OpenClaw's
  // normal tool/reasoning/message compatibility wrappers active.
  return Object.assign(wrapped, { preservesGenericCompatibility: true as const });
}

/**
 * Accepted API-key env names, in precedence order. The first non-empty value wins.
 * AGVI_0G_COMPUTE_API_KEY is canonical (matches openclaw.plugin.json setup.providers).
 * ZEROG_COMPUTE_API_KEY is the legacy name (README, earlier onboarding) and stays accepted.
 * Keep openclaw.plugin.json setup.providers[0].envVars in the same order (contract test enforces it).
 */
export const ENV_VARS = ["AGVI_0G_COMPUTE_API_KEY", "ZEROG_COMPUTE_API_KEY"] as const;

function catalogDiscoveryConfig(): ModelPolicy["capabilityDiscovery"] {
  return resolveModelPolicy(runtimePluginConfig, HAIKU).capabilityDiscovery;
}

async function loadLiveCatalog(signal?: AbortSignal) {
  const rows = await discoverModels(catalogDiscoveryConfig(), signal);
  return buildModelCatalog(rows);
}

function resolveCachedDynamicModel(modelId: string) {
  const row = discoverModelSWR(modelId, catalogDiscoveryConfig(), (error) => {
    runtimeLogger?.debug?.(`agvi-0g-compute live catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  return row ? buildModelFromRemote(row) : undefined;
}

function toRuntimeModel(model: ReturnType<typeof buildModelFromRemote>) {
  return model ? { ...model, provider: PROVIDER, baseUrl: ROUTER_BASE_URL } : undefined;
}

export default definePluginEntry({
  id: PROVIDER,
  name: "AGVI 0G Compute",
  description: "Direct, protocol-aware 0G Compute inference with per-model transport, routing, trust and TEE policy.",
  register(api) {
    runtimeLogger = api.logger as RuntimeLogger;
    runtimePluginConfig = parsePluginConfig(api.pluginConfig);
    api.registerProvider({
      id: PROVIDER,
      label: "0G Compute (direct)",
      docsPath: "/providers/agvi-0g-compute",
      envVars: [...ENV_VARS],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER,
          methodId: "api-key",
          label: "0G Compute API key",
          hint: "Create a router key on pc.0g.ai (never enter a wallet private key)",
          optionKey: "zerogComputeApiKey",
          flagName: "--zerog-compute-api-key",
          // Interactive/non-interactive onboarding prefill reads one name only; keep the legacy
          // name so existing scripted flows keep working. Runtime resolution accepts both names.
          envVar: "ZEROG_COMPUTE_API_KEY",
          promptMessage: "Enter your 0G Compute Router API key",
          defaultModel: `${PROVIDER}/${HAIKU}`,
          expectedProviders: [PROVIDER],
        }),
      ],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey(PROVIDER).apiKey;
          if (!apiKey) return null;
          let models = MODEL_CATALOG;
          try {
            models = await loadLiveCatalog(ctx.signal);
          } catch (error) {
            runtimeLogger?.warn?.(`agvi-0g-compute live catalog unavailable; using curated fallback: ${error instanceof Error ? error.message : String(error)}`);
          }
          return {
            provider: {
              baseUrl: ROUTER_BASE_URL,
              apiKey,
              api: "openai-completions",
              timeoutSeconds: DEFAULT_REQUEST_TIMEOUT_SECONDS,
              models,
            },
          };
        },
      },
      resolveDynamicModel: ({ modelId }) => toRuntimeModel(resolveCachedDynamicModel(modelId)),
      prepareDynamicModel: async ({ modelId }) => {
        try {
          const row = await discoverModel(modelId, catalogDiscoveryConfig());
          return toRuntimeModel(row ? buildModelFromRemote(row) : undefined);
        } catch (error) {
          runtimeLogger?.debug?.(`agvi-0g-compute dynamic model lookup failed model=${routeKey(modelId)} error=${error instanceof Error ? error.message : String(error)}`);
          return undefined;
        }
      },
      normalizeConfig: ({ providerConfig }) => {
        // OpenClaw requires custom providers to declare a `models` array in the
        // config file before plugin normalization runs. Treat those rows as
        // validator/discovery stubs only: runtime metadata always comes from
        // this plugin's canonical MODEL_CATALOG so stale inline limits/prices
        // cannot silently override the adapter.
        return {
          ...providerConfig,
          timeoutSeconds: providerConfig.timeoutSeconds ?? DEFAULT_REQUEST_TIMEOUT_SECONDS,
          models: MODEL_CATALOG,
        };
      },
      resolveThinkingProfile: ({ modelId }) => {
        const profile = getModelMetadata(modelId)?.thinkingProfile;
        return profile
          ? { levels: profile.levels.map((level) => ({ ...level })), defaultLevel: profile.defaultLevel }
          : undefined;
      },
      wrapStreamFn: wrapZeroGProviderStream,
      wrapSimpleCompletionStreamFn: wrapZeroGProviderStream,
      classifyFailoverReason: ({ errorMessage }) => {
        // These are response-shape failures, not transient network failures.
        // Marking them as format prevents the host from treating a broken tool
        // payload as an identical same-model timeout retry.
        if (/incomplete or malformed tool call|invalid tool call/i.test(errorMessage)) return "format";
        // Circuit-open is deliberate fail-fast protection; do not immediately
        // re-enter the same unhealthy route via the transient retry loop.
        if (errorMessage.includes(CIRCUIT_OPEN_ERROR_PREFIX)) return "format";
        if (errorMessage.includes(PINNED_PROVIDER_FALLBACK_PREFIX)) return "format";
        return undefined;
      },
    });
  },
});
