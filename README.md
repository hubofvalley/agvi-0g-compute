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

### Install from ClawHub

This is the recommended installation once the package release is visible in ClawHub:

```bash
openclaw plugins install clawhub:openclaw-plugin-agvi-0g-compute
```

If ClawHub still reports that the package is not visible while its security review is pending, install the tagged GitHub release instead.

### Install the GitHub release

```bash
openclaw plugins install git:github.com/hubofvalley/agvi-0g-compute@v0.1.0
```

The GitHub installation requires access to the repository while it is private.

### Install from a local checkout

Useful for development or when testing a specific commit:

```bash
git clone https://github.com/hubofvalley/agvi-0g-compute.git
cd agvi-0g-compute
npm ci
npm run validate
openclaw plugins install "$PWD" --force
```

Local and GitHub installs run on the machine that hosts the OpenClaw Gateway. After installation, verify the plugin is loaded:

```bash
openclaw plugins list
openclaw models list --provider agvi-0g-compute
```

## Configure authentication

Use a Router API key from your 0G Compute account. The plugin accepts these environment variables, in this order:

1. `AGVI_0G_COMPUTE_API_KEY` — canonical name.
2. `ZEROG_COMPUTE_API_KEY` — legacy compatibility name.

For a Gateway launched from the shell:

```bash
export AGVI_0G_COMPUTE_API_KEY="<your-0g-router-api-key>"
```

For a persistent Gateway installation, add the variable to the Gateway service environment or use OpenClaw's interactive API-key flow:

```bash
openclaw models auth login --provider agvi-0g-compute --method api-key
```

Keep the key out of source files, Git, chat messages, and shell history. The provider never needs a wallet/private key.

## Quick start

Choose one of the models registered by the plugin as the OpenClaw default:

```bash
openclaw models set agvi-0g-compute/glm-5.3
```

Other available model references:

- `agvi-0g-compute/claude-haiku-5.5`
- `agvi-0g-compute/deepseek-v4.1-flash`
- `agvi-0g-compute/qwen3.7-flash`
- `agvi-0g-compute/glm-5.3-flash`
- `agvi-0g-compute/glm-5.3`

Then start a new OpenClaw turn. If the Gateway was already running before the key or plugin was installed, restart it using the normal OpenClaw service workflow.

## Models and transports

| Model | OpenClaw reference | Default transport |
|---|---|---|
| Claude Haiku 5.5 | `agvi-0g-compute/claude-haiku-5.5` | Anthropic Messages |
| DeepSeek V4.1 Flash | `agvi-0g-compute/deepseek-v4.1-flash` | Chat Completions |
| Qwen 3.7 Flash | `agvi-0g-compute/qwen3.7-flash` | Chat Completions |
| GLM 5.3 Flash | `agvi-0g-compute/glm-5.3-flash` | Chat Completions |
| GLM 5.3 | `agvi-0g-compute/glm-5.3` | Chat Completions |

The `auto` transport is a model-specific preference validated against 0G capability data. You can explicitly select `chat-completions`, `messages`, or `responses` when the router advertises that format.

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
