# Token-saving investigation: 0G Compute provider (2026-11-08)

Status (updated 2026-11-08): **no plugin hook added.** Core already caches this route by default. A bounded paired A/B measured the effect of disabling it. Live request behaviour is unchanged.

## 1. What the SDK exposes (names verified, semantics NOT yet verified)

Verified by reading the installed OpenClaw 2026.10.10 `ProviderPlugin` type (names only):

- Prompt/tool shaping: `transformSystemPrompt`, `resolveSystemPromptContribution`, `supportsSystemPromptCacheBoundary`, `normalizeToolSchemas`, `inspectToolSchemas`
- Request shaping: `prepareExtraParams`, `extraParamsForTransport`, `wrapStreamFn`, `createStreamFn`, `wrapSimpleCompletionStreamFn`
- Replay/history: `sanitizeReplayHistory`, `sanitizeReplayHistoryAsync`, `validateReplayTurns`, `buildReplayPolicy`
- Cache/usage: `isCacheTtlEligible`, `applyNativeStreamingUsageCompat`, `resolveTransportTurnState`, `fetchUsageSnapshot`

Not yet verified: argument shapes, ordering, and whether each hook runs before or after cache-prefix construction. Reading those is the first step before any implementation.

## 2. Candidate transforms, ranked by fidelity risk

| Rank | Transform | Mechanism | Fidelity risk | Notes |
|---|---|---|---|---|
| 1 | Deterministic tool-schema ordering and stable prefix | `normalizeToolSchemas` | Very low | No content change. Can raise cache hits if the prefix is currently unstable. Measure first. |
| 2 | `cache_control` placement on the stable prefix (Haiku, Anthropic Messages) | `prepareExtraParams` / `wrapStreamFn` | Low | Router lists `cache_control` for Haiku. Cost effect depends on the unverified cache-read rate. |
| 3 | Tool-output truncation or summarisation | `wrapStreamFn` on tool results | High | Can silently drop facts the model needs. Requires a fidelity check per tool. |
| 4 | System-prompt trimming | `transformSystemPrompt` | High | Can change behaviour and policy compliance. Requires quality grading. |

Rule: ship ranks 1–2 only if measurements show gains. Ranks 3–4 need an explicit go decision.

## 3. Proposed opt-in mechanism (not implemented)

- Config key under the plugin entry, default `off`. This needs a `configSchema` change, because the current schema is `additionalProperties: false` with no properties.
  - `off`: no-op. Identical behaviour to today.
  - `measure`: record usage fields only. Request bytes are unchanged.
  - `apply:<transform-id>`: applies one named transform. Allowed only after an A/B pass.
- Each transform is a separate function with unit tests, so one can be disabled without touching the others.
- Rollback: set the mode back to `off`. No gateway restart is needed for a config-only change, but confirm this with the gateway owner first.
- The live subagent default (`agvi-0g-compute/claude-haiku-5.5`) must not be the A/B arm target. Use an isolated test agent.

## 4. Pricing and usage prerequisites (blockers for claiming savings)

- Haiku cache-read price ($0.01/M in plugin; not in the public listing) is **unverified**. Cache savings cannot be quoted until it is checked against billing or official docs.
- Haiku >100k tier: whether cached tokens count toward the threshold is **unverified** (the plugin assumes they do).
- DeepSeek cache rates are stored as `0`, which means unknown, not free. Do not measure cache savings on DeepSeek.
- Whether router responses return cache-read and cache-write token counts in `usage` is **unverified** for this route. Without them, no cache A/B is possible.

## 5. A/B test plan

Arms (same model: Haiku, same fixed corpus):

- **A (control):** current behaviour.
- **B1:** rank 1 (stable ordering).
- **B2:** rank 1 + rank 2 (cache markers).
- **B3 (only if B2 passes and a fidelity case exists):** rank 3 for one tool class.

Corpus and design:

- Fixed set of tasks that mirror real subagent work: multi-step tool use, long tool outputs, and plain Q&A. Freeze the corpus before running. Keep secrets and personal data out.
- Paired design: each task runs once per arm, with randomised arm order per task. Repeat runs to estimate variance.
- Pre-register before running: the primary metric, the minimum detectable effect, and the non-inferiority margin for quality (for example, a pass-rate drop of no more than 5 percentage points).
- Sample size: compute it from pilot variance. Do not guess it.

Metrics per run:

- Cost: from the router's usage fields and verified rates only. Report token counts separately from USD.
- Quality: task pass/fail by a deterministic grader where possible. Otherwise a blinded rubric.
- Tool-output fidelity: for each tool result, check that the required facts survive the transform. Use a checklist per tool class and count misses.
- Operational: error rate, timeout rate, p50/p95 latency, tool-call count.

Decision rule:

- Claim savings only if the paired cost-difference confidence interval excludes zero **and** quality is within the pre-registered margin **and** fidelity misses do not increase.
- Otherwise report: "no measured savings". Do not report an estimate as a result.

Safety for the test itself:

- Hard budget cap per arm, set before the run.
- Runs happen in an isolated session. No change to `openclaw.json` or the default subagent.
- Store results as aggregate numbers. Do not store prompts or completions in the report.

## 6. Next steps (not started)

1. Read the signatures and call order of ranks 1–2 hooks in the installed SDK.
2. Confirm cache-read and cache-write fields in router responses (one minimal, budgeted probe, with Bertold's go-ahead).
3. Verify cache rates against billing or official docs.
4. Draft the corpus and pre-registration, then get sign-off before any live run.

## 7. Measured results (2026-11-08, bounded A/B, `claude-haiku-5.5`)

Harness: `/tmp/agvi0g-scratch/ab/` (scratch, not in the plugin). Real `@openclaw/ai` Anthropic Messages transport. 3 tasks x 3 calls x 2 arms x 2 repeats = 36 calls, alternating arm order. Temperature 0, maxTokens 800. Base tier only (all prompts under 100K tokens). API key read from the existing secret file into the process environment, never printed.

| Arm | Calls | Input | Cache read | Cache write | Output | Est. USD (verified base rates) |
|---|---|---|---|---|---|---|
| A: `cacheRetention: "none"` | 18 | 329,752 | 0 | 0 | 3,491 | 0.03469 |
| B: default | 18 | 60 | 206,562 | 123,130 | 4,444 | 0.01968 |

Per repeat (estimated USD, computed from the run): repeat 1 arm A 0.01742 vs arm B 0.01603 (about 8% lower). Repeat 2 arm A 0.01727 vs arm B 0.00366 (about 79% lower). Overall arm B is about 43% lower (0.01968 vs 0.03469). Repeat 1 had more cache writes, so its saving was smaller. The saving depends on how often the same prefix is reused within the cache window. Two repeats are too few to generalise.

Quality and fidelity:

- Final answers: 6/6 pass in each arm (each answer contains the expected fact from the tool output). Answer text is identical in 11/18 pairs, so temperature 0 is not fully deterministic.
- Payload fidelity: after removing `cache_control` and normalising the text-block representation of the final user message, 9/9 request payloads are identical between arms. The tool outputs appear verbatim in all 9.
- The cache markers are the only request difference, and they do not alter tool output or policy text.

USD caveats: estimates use the official 0G rates for base-tier Haiku. The router's `pricing_usd` fields are derived from neuron prices at a single snapshot rate (about 0.1472 USD per 0G, which drifted slightly between fetches), so they are not independent USD prices.

## 8. DeepSeek observations

- `deepseek-v4.1-flash` via the OpenAI-completions transport returned HTTP 400 for the `developer` role. The fix (`compat.supportsDeveloperRole: false`) was validated: both calls succeed.
- The route caches prefixes automatically (second call: 5,888 cache-read tokens, no markers). The verified cache-read rate is $0.0416/M. Cache writes have no published rate.
- Not measured as an A/B. A DeepSeek cache A/B needs the router's cache controls, which were not found.

## 9. Decision

- Caching is already on by default for Haiku, so a new "enable caching" hook would not change behaviour and was not added.
- A `cacheRetention: "long"` opt-in would add cache-write cost (1h write is about $0.2/M) and is not a saver for short sessions. Not built.
- Tool-output truncation and system-prompt trimming (ranks 3-4) were not built, since they risk fidelity and no measured need was shown.
