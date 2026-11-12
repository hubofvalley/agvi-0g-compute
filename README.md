# AGVI 0G Compute

An OpenClaw provider plugin for the official [0G Compute Router](https://router-api.0g.ai/v1). It connects directly to 0G, without a local proxy, and provides model-aware transports, capability discovery, provider routing, trust/TEE policy, observability, and route resilience.

- **Provider:** `agvi-0g-compute`
- **Minimum OpenClaw version:** `2026.10.10`
- **Router endpoint:** `https://router-api.0g.ai/v1`
- **Current release:** [`v0.1.0`](https://github.com/hubofvalley/agvi-0g-compute/releases/tag/v0.1.0)

## Installation

You need:

1. An OpenClaw installation running version `2026.10.10` or newer.
2. A **0G Compute Router API key**. Do not use a wallet address or private key.

### 1. Create a 0G Compute Router API key

1. Open [pc.0g.ai](https://pc.0g.ai/).
2. Sign in or create an account, then create a **Compute Router API key**.
3. Copy the key and keep it private.

> **Important:** use a 0G **Router API key**. Never paste a wallet private key, seed phrase, or wallet address into OpenClaw.

### 2. Install the plugin

#### ClawHub (recommended)

Use the ClawHub package when its release is visible in the registry:

```bash
openclaw plugins install clawhub:openclaw-plugin-agvi-0g-compute
```

If ClawHub reports that the package is not visible while its security review is pending, use the public GitHub release below.

#### GitHub release (public fallback)

```bash
openclaw plugins install git:github.com/hubofvalley/agvi-0g-compute@v0.1.0
```

The repository is public, so this installation does not require GitHub credentials.

#### Local checkout (development)

```bash
git clone https://github.com/hubofvalley/agvi-0g-compute.git
cd agvi-0g-compute
npm ci
npm run validate
openclaw plugins install "$PWD" --force
```

All installs run on the machine that hosts the OpenClaw Gateway. Verify that OpenClaw can see the provider:

```bash
openclaw plugins list
openclaw models list --provider agvi-0g-compute
```

If the plugin is installed but shown as disabled, enable it:

```bash
openclaw plugins enable agvi-0g-compute
```

### 3. Give the API key to the Gateway

The API key is credential data, not plugin policy configuration. Use one of these supported methods.

#### Option A: environment variable

For a Gateway launched from the current shell:

```bash
export AGVI_0G_COMPUTE_API_KEY="<your-0g-router-api-key>"
```

For a persistent Gateway service, add the same variable to the service environment so the Gateway—not only your interactive shell—can read it, then restart the Gateway. The canonical variable is `AGVI_0G_COMPUTE_API_KEY`; the legacy `ZEROG_COMPUTE_API_KEY` name is also accepted.

#### Option B: OpenClaw credential store

Let OpenClaw prompt for the key and store it as a provider credential:

```bash
openclaw models auth login --provider agvi-0g-compute --method api-key
```

Keep the key out of source files, Git, README examples, chat messages, and shell history. Do not put it in `plugins.entries.agvi-0g-compute.config`; that section is for routing, transport, trust, TEE, discovery, and observability policies.

### 4. Select a model

The plugin refreshes its catalog from the 0G Router `/v1/models` inventory. It exposes every router row that is a text-output `chatbot` and keeps the five existing routes as curated compatibility overrides.

```bash
openclaw models list --provider agvi-0g-compute
```

The catalog is cached (default TTL: 300 seconds), falls back to the curated entries when the router is unavailable, and also resolves a newly advertised text model on demand. The exact model count can change as 0G publishes or retires models.

Set the OpenClaw default model:

```bash
openclaw models set agvi-0g-compute/glm-5.3
```

After installing the plugin or changing the Gateway environment, start a new turn; restart the Gateway first if it was already running.

### Setup checklist

- [ ] Router API key created at [pc.0g.ai](https://pc.0g.ai/).
- [ ] Plugin installed and visible in `openclaw plugins list`.
- [ ] `openclaw models list --provider agvi-0g-compute` shows the live text/chat inventory.
- [ ] Gateway received the API key and the selected model is `agvi-0g-compute/<model>`.

## Curated model transports

The rows below document the five compatibility overrides; live chat models use the same transport selection rules from their advertised router formats.

| Model | OpenClaw reference | Default transport |
|---|---|---|
| Claude Haiku 5.5 | `agvi-0g-compute/claude-haiku-5.5` | Anthropic Messages |
| DeepSeek V4.1 Flash | `agvi-0g-compute/deepseek-v4.1-flash` | Chat Completions |
| Qwen 3.7 Flash | `agvi-0g-compute/qwen3.7-flash` | Chat Completions |
| GLM 5.3 Flash | `agvi-0g-compute/glm-5.3-flash` | Chat Completions |
| GLM 5.3 | `agvi-0g-compute/glm-5.3` | Chat Completions |

The `auto` transport is a model-specific preference validated against 0G capability data. You can explicitly select `chat-completions`, `messages`, or `responses` when the router advertises that format.

The 0G inventory also contains image-generation, video-generation, text-to-speech, speech-to-text, embedding, and decision models. They are intentionally not inserted into this text-provider catalog: OpenClaw's `ProviderPlugin` model contract routes ordinary agent turns through text transports, so presenting those rows as chat models would be misleading and could send incompatible payloads. The live capability fields are preserved by discovery for future native capability adapters.

## Plugin configuration

Configuration belongs under `plugins.entries.agvi-0g-compute.config`. The defaults are conservative: automatic transport, routing disabled, key-default trust, optional TEE verification, capability discovery enabled, and safe observability.

```json
{
  "plugins": {
    "entries": {
      "agvi-0g-compute": {
        "enabled": true,
        "config": {
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
            "claude-haiku-5.5": {
              "transport": "messages"
            },
            "glm-5.3": {
              "trust": {
                "mode": "private",
                "allowDowngrade": false
              },
              "teeVerification": {
                "enabled": true,
                "required": true
              }
            }
          }
        }
      }
    }
  }
}
```

Model-specific settings override `defaults`. Set `inheritDefaults: false` on a model when it should start from the plugin's built-in safe defaults instead.

### Transport

- `auto`: model-specific preference with capability validation.
- `chat-completions`: OpenAI Chat Completions compatibility.
- `messages`: Anthropic Messages compatibility; used by Claude Haiku 5.5 by default.
- `responses`: OpenAI Responses compatibility.

### Provider routing

Routing is disabled by default. When enabled, the plugin can emit native 0G routing headers:

- `X-0G-Provider-Address`
- `X-0G-Provider-Identity`
- `X-0G-Provider-Sort: latency`
- `X-0G-Provider-Allow-Fallbacks`

A routing `identity` requires an `address`. A pinned unhealthy provider fails safely when fallbacks are disabled and discovery can confirm the condition.

### Trust and TEE verification

Trust modes are:

- `key-default`: omit a trust override and use the API key's dashboard default.
- `verified`: request `X-0G-Provider-Trust-Mode: verified`.
- `private`: request `X-0G-Provider-Trust-Mode: private`.

Private mode is fail-closed by default. A private request is not silently downgraded unless `allowDowngrade: true` is explicitly permitted and the route is not pinned or TEE-required. A private response must report `X-0G-E2EE: sealed`.

`teeVerification.enabled` asks the router to verify TEE only when the selected model is identified as TEE-capable. `required: true` additionally requires a private route and fails closed when TEE capability cannot be established. The plugin does not fabricate a `tee_verified=true` result from a generic OpenClaw text stream.

GLM 5.3 currently has a private TEE provider. GLM 5.3 Flash currently does not, so a private/required-TEE request for Flash fails safely unless an explicit downgrade policy allows it.

## Capability discovery

When enabled, the plugin discovers and caches:

- public `/v1/models` metadata: formats, limits, provider count, and TEE information;
- authenticated `/v1/providers?model=...` metadata: provider health, address, identity, trust mode, and TEE attributes.

The default cache TTL is 300 seconds and discovery timeout is 5 seconds. Ordinary key-default inference uses stale-while-revalidate behavior so discovery does not block normal time-to-first-token. Security-sensitive paths—private trust, required TEE, and pinned routing—wait for fresh data and fail closed when it is unavailable.

## Observability and resilience

With observability enabled, logs report model, effective transport/trust, HTTP status, a shortened provider address, E2EE state, TEE request state, fallback detection, correlation information when available, and response-header latency. Prompts, completions, and API keys are not logged.

The provider also includes:

- a 180-second provider request budget when no operator timeout is configured;
- a 15-second cap on provider/SDK `Retry-After` waits;
- a per-model circuit breaker after two timeout-like stalled streams, with a 120-second cooldown;
- progress-aware recovery, so HTTP headers alone do not mark a route healthy;
- non-transient classification for malformed tool calls and open-circuit failures.

The OpenClaw host's own first-event/idle watchdog can still abort a turn earlier than the provider budget.

## Verification and maintenance

From a source checkout:

```bash
npm ci
npm test
npx tsc -p tsconfig.json --noEmit
npm run validate
npm run audit:runtime
```

Available local tools:

- `npm run health-check -- --json`: check the public 0G catalog.
- `npm run health-check -- --probe --json`: run small authenticated probes without printing the key or response text.
- `npm run catalog-compare -- --fetch --json`: compare plugin metadata with the public 0G listing.
- `npm run usage-report -- --file <usage.jsonl> --json`: calculate a local, read-only usage estimate.

The plugin owns its canonical model catalog and compiled runtime under `dist/`. Do not replace the published `dist/` entrypoint with `src/index.ts`.

## Security

- Use a 0G Router API key, never a wallet/private key.
- Keep credentials in the Gateway environment or OpenClaw's credential store.
- Review provider routing and private/TEE policies before enabling them in production.
- See [SECURITY.md](SECURITY.md) for reporting security issues.

## License

Apache-2.0
