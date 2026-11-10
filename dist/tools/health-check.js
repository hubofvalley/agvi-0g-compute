/**
 * Read-only 0G Router health check.
 *
 * Default mode calls only the public /v1/models endpoint.
 * `--probe` additionally sends a tiny authenticated streaming request to each
 * OpenAI-compatible AGVI model using an API key from the environment only.
 * The key, prompts, and response text are never printed.
 *
 *   npm run build
 *   npm run health-check -- --json
 *   AGVI_0G_COMPUTE_API_KEY=... npm run health-check -- --probe --json
 */
import { pathToFileURL } from "node:url";
const BASE_URL = "https://router-api.0g.ai/v1";
const CATALOG_URL = `${BASE_URL}/models`;
const OPENAI_MODELS = ["qwen3.7-flash", "deepseek-v4.1-flash", "glm-5.3-flash", "glm-5.3"];
const ALL_MODELS = ["claude-haiku-5.5", ...OPENAI_MODELS];
const CATALOG_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 60_000;
function apiKeyFromEnv() {
    return process.env.AGVI_0G_COMPUTE_API_KEY?.trim() || process.env.ZEROG_COMPUTE_API_KEY?.trim() || undefined;
}
function safeError(error) {
    if (error instanceof DOMException && error.name === "AbortError")
        return "probe timeout/abort";
    if (error instanceof Error)
        return `${error.name}: ${error.message}`.slice(0, 300);
    return String(error ?? "unknown error").slice(0, 300);
}
async function fetchCatalog() {
    const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) });
    if (!response.ok)
        throw new Error(`catalog HTTP ${response.status}`);
    const body = (await response.json());
    return ALL_MODELS.map((id) => {
        const model = body.data?.find((entry) => entry.id === id);
        return {
            model: id,
            present: Boolean(model),
            ...(typeof model?.provider_count === "number" ? { providerCount: model.provider_count } : {}),
            formats: model?.supported_formats ?? [],
            parameters: model?.supported_parameters ?? [],
        };
    });
}
async function readFirstSseData(response, startedAt) {
    const reader = response.body?.getReader();
    if (!reader)
        return undefined;
    const decoder = new TextDecoder();
    let buffer = "";
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                return undefined;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? "";
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith(":"))
                    continue;
                if (trimmed.startsWith("data:"))
                    return Date.now() - startedAt;
            }
        }
    }
    finally {
        await reader.cancel().catch(() => undefined);
    }
}
async function probeOpenAiModel(model, apiKey) {
    const startedAt = Date.now();
    try {
        const response = await fetch(`${BASE_URL}/chat/completions`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                Accept: "text/event-stream",
            },
            body: JSON.stringify({
                model,
                messages: [{ role: "user", content: "Reply with exactly OK." }],
                stream: true,
                max_tokens: 8,
            }),
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        const headersMs = Date.now() - startedAt;
        const requestIdPresent = Boolean(response.headers.get("x-request-id"));
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            return { model, ok: false, status: response.status, headersMs, requestIdPresent, error: `HTTP ${response.status}` };
        }
        const firstEventMs = await readFirstSseData(response, startedAt);
        return {
            model,
            ok: firstEventMs !== undefined,
            status: response.status,
            headersMs,
            firstEventMs,
            requestIdPresent,
            ...(firstEventMs === undefined ? { error: "stream ended before first SSE data event" } : {}),
        };
    }
    catch (error) {
        return { model, ok: false, error: safeError(error) };
    }
}
function printHuman(catalog, probes) {
    for (const row of catalog) {
        process.stdout.write(`${row.model}: catalog=${row.present ? "ok" : "missing"}` +
            `${row.providerCount !== undefined ? ` providers=${row.providerCount}` : ""}` +
            ` formats=${row.formats.join(",") || "-"} params=${row.parameters.join(",") || "-"}\n`);
    }
    for (const row of probes ?? []) {
        process.stdout.write(`${row.model}: probe=${row.ok ? "ok" : "fail"}` +
            `${row.status ? ` http=${row.status}` : ""}` +
            `${row.headersMs !== undefined ? ` headersMs=${row.headersMs}` : ""}` +
            `${row.firstEventMs !== undefined ? ` firstEventMs=${row.firstEventMs}` : ""}` +
            `${row.error ? ` error=${row.error}` : ""}\n`);
    }
}
export async function runHealthCheck(argv) {
    const catalog = await fetchCatalog();
    if (!argv.includes("--probe"))
        return { catalog };
    const apiKey = apiKeyFromEnv();
    if (!apiKey)
        throw new Error("--probe requires AGVI_0G_COMPUTE_API_KEY or ZEROG_COMPUTE_API_KEY in the environment");
    const probes = [];
    for (const model of OPENAI_MODELS)
        probes.push(await probeOpenAiModel(model, apiKey));
    return { catalog, probes };
}
async function main(argv) {
    const result = await runHealthCheck(argv);
    if (argv.includes("--json"))
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else
        printHuman(result.catalog, result.probes);
    if (result.catalog.some((row) => !row.present) || result.probes?.some((row) => !row.ok))
        process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2)).catch((error) => {
        process.stderr.write(`health-check failed: ${safeError(error)}\n`);
        process.exitCode = 1;
    });
}
