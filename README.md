# AGVI 0G Compute (OpenClaw provider)

An OpenClaw-native adapter for the official 0G Compute Router (`https://router-api.0g.ai/v1`). It is independent from the local 9router proxy and owns 0G-specific model metadata, transport selection, provider routing, trust policy, TEE request shaping, discovery, observability, and route resilience.

## Models and automatic transport

| Model | OpenClaw reference | `transport: auto` |
|---|---|---|
| Claude Haiku 5.5 | `agvi-0g-compute/claude-haiku-5.5` | Messages |
| DeepSeek V4.1 Flash | `agvi-0g-compute/deepseek-v4.1-flash` | Chat Completions |
| Qwen 3.7 Flash | `agvi-0g-compute/qwen3.7-flash` | Chat Completions |
| GLM 5.3 Flash | `agvi-0g-compute/glm-5.3-flash` | Chat Completions |
| GLM 5.3 | `agvi-0g-compute/glm-5.3` | Chat Completions |

`auto` is only a preference. A model can explicitly select `chat-completions`, `messages`, or `responses` when 0G advertises that format. Capability discovery validates explicit choices against `/v1/models` when available. GLM 5.3 and GLM 5.3 Flash currently advertise all three formats; DeepSeek and Qwen advertise Chat Completions + Responses; Haiku advertises Chat Completions + Messages.

The plugin catalog is the runtime source of truth for model metadata. OpenClaw requires custom providers to declare a full `models` array in config before plugin normalization runs, so AGVI keeps a compatibility projection there. `normalizeConfig` replaces that projection with this plugin's canonical `MODEL_CATALOG` before inference, preventing stale inline limits/prices from winning.

## Plugin config

Settings live under `plugins.entries.agvi-0g-compute.config`. Global defaults can be inherited and selectively overridden per model. `inheritDefaults: false` makes that model start from the plugin's built-in safe defaults instead of the configured global defaults.

```json
{
  "defaults": {
    "transport": "auto",
    "routing": {
      "enabled": false,
      "allowFallbacks": true
    },
    "trust": {
      "mode": "key-default",
      "allowDowngrade": false
    },
    "teeVerification": {
      "enabled": false,
      "required": false
    },
    "capabilityDiscovery": {
      "enabled": true,
      "ttlSeconds": 300,
      "timeoutMs": 5000
    },
    "observability": {
      "enabled": true
    }
  },
  "models": {
    "claude-haiku-5.5": { "transport": "messages" },
    "glm-5.3-flash": { "transport": "chat-completions" },
    "glm-5.3": {
      "inheritDefaults": true,
      "trust": { "mode": "private", "allowDowngrade": false },
      "teeVerification": { "enabled": true, "required": true }
    }
  }
}
```

### Transport

- `auto`: model-specific preference with capability validation.
- `chat-completions`: OpenAI Chat Completions (`openai-completions`).
- `messages`: Anthropic Messages (`anthropic-messages`).
- `responses`: OpenAI Responses (`openai-responses`).

### Provider routing

Routing is off by default so upgrading the plugin does not silently change 0G's existing price/health selection. When enabled, the plugin can emit the native 0G headers:

- `X-0G-Provider-Address`
- `X-0G-Provider-Identity`
- `X-0G-Provider-Sort: latency`
- `X-0G-Provider-Allow-Fallbacks`

`identity` requires `address`. If a pinned provider is unhealthy and fallbacks are disabled, the plugin fails before inference when discovery can prove that condition.

### Trust mode

- `key-default`: send no trust override header; the API key's dashboard default applies.
- `verified`: send `X-0G-Provider-Trust-Mode: verified`.
- `private`: send `X-0G-Provider-Trust-Mode: private`.

Private mode is fail-closed by default. With discovery enabled, a model with no healthy private provider is rejected unless `allowDowngrade: true`. A successful private response must report `X-0G-E2EE: sealed`; otherwise the request is rejected.

### TEE verification

`teeVerification.enabled` injects `verify_tee: true` only for a model that discovery/static metadata identifies as TEE-capable. `required: true` also requires `trust.mode: private` and fails closed if TEE capability cannot be established.

0G returns the detailed `tee_verified` result inside its response trace. OpenClaw's generic text transports do not expose that raw trace to provider wrappers, so this plugin does **not** claim independent trace parsing. `required` therefore enforces: TEE-capable model + private route + router-side `verify_tee` request + sealed E2EE response. It does not fabricate a `tee_verified=true` observation.

GLM 5.3 currently has a Private TEE provider; GLM 5.3 Flash currently does not. Asking Flash for private/required TEE therefore fails safely rather than silently downgrading, unless downgrade is explicitly enabled.

## Dynamic capability discovery

With discovery enabled, the plugin caches:

- public `/v1/models`: formats, parameters, context/output limits, provider count, TEE metadata;
- authenticated `/v1/providers?model=...`: provider health, address/identity, trust mode and TEE attributes.

The default cache TTL is 300 seconds and the discovery request timeout is 5 seconds. Ordinary standard/key-default inference can continue using static plugin metadata if discovery is temporarily unavailable. Security-sensitive private/required-TEE requests fail closed unless an explicit downgrade policy permits otherwise.

## Observability

Provider logs contain no prompts, completions, or API keys. When enabled they report model, effective transport, effective trust mode, HTTP status, a shortened selected provider address, E2EE state, whether TEE verification was requested, pin-fallback detection, request correlation when available, and response-header latency.

## Resilience

- Provider transport request budget: 180 seconds when the operator has not set a provider timeout. This is **not** a replacement for OpenClaw's own first-event/idle watchdog; the host can abort sooner (currently 120 seconds for ordinary cloud turns).
- Provider/SDK `Retry-After` waits are capped at 15 seconds.
- Two timeout-like stalls open an in-memory per-model circuit breaker for 120 seconds.
- A route is marked recovered only after a real model progress event (`text/thinking/tool-call` progress or terminal success), not merely because HTTP 200 headers arrived.
- Abort listeners are removed when the observed stream settles, preventing completed requests from later being misclassified as stalls.
- Malformed tool-call payloads and circuit-open failures are classified as non-transient format failures so OpenClaw does not immediately repeat the same bad route.

## Authentication

Use a 0G **Router API key**, never a wallet/private key. Accepted environment names are `AGVI_0G_COMPUTE_API_KEY` (canonical) and `ZEROG_COMPUTE_API_KEY` (legacy). SecretRef-backed provider configuration remains supported.

## Verification and tools

- `npm test`: offline unit/contract/regression tests.
- `npm run validate`: TypeScript build + Plugin Inspector.
- `npm run health-check -- --json`: public catalog health.
- `npm run health-check -- --probe --json`: tiny authenticated Chat Completions probes; the key and response text are never printed.
- `npm run catalog-compare -- --fetch --json`: compare plugin metadata to the public 0G listing.
- `npm run usage-report -- --file <usage.jsonl> --json`: local read-only cost estimate.

The dated public catalog fixture lives under `src/fixtures/` and is evidence for offline tests, not a replacement for live capability discovery.
