/** Where a model's spend is counted: `free` providers against the free cap, `paid` against the paid one. */
export type AiTier = "free" | "paid";

export type AiProviderDef = {
	id: string;
	name: string;
	tier: AiTier;
	/** OpenAI-compatible base, without a trailing slash. `{account}` is filled from a Cloudflare key. */
	baseUrl: string;
	/** Provider id in the models.dev catalog, for prices and model metadata. */
	catalogId?: string;
	/** Where to get a key, shown in the setup wizard. */
	keyUrl?: string;
	keyHint: string;
	/** Tried first by `auto` when the provider's model list is not loaded yet. */
	defaultModel?: string;
	/** Only these model ids count as free; others are hidden. Absent: every model is free. */
	freeModel?: (id: string) => boolean;
	/** Models served when the provider has no usable `/models` listing. */
	staticModels?: string[];
	/** Each key carries its own base URL (Ollama, vLLM, LM Studio). */
	customBaseUrl?: boolean;
};

/**
 * Free-tier providers that speak the OpenAI chat API, plus the paid ones. Every request goes
 * through `/chat/completions`; Anthropic and OpenAI also get their native APIs passed through.
 */
export const aiProviders = [
	{
		id: "groq",
		name: "Groq",
		tier: "free",
		baseUrl: "https://api.groq.com/openai/v1",
		catalogId: "groq",
		keyUrl: "https://console.groq.com/keys",
		keyHint: "gsk_…",
		defaultModel: "llama-3.3-70b-versatile",
	},
	{
		id: "cerebras",
		name: "Cerebras",
		tier: "free",
		baseUrl: "https://api.cerebras.ai/v1",
		catalogId: "cerebras",
		keyUrl: "https://cloud.cerebras.ai",
		keyHint: "csk-…",
		defaultModel: "gpt-oss-120b",
	},
	{
		id: "gemini",
		name: "Google Gemini",
		tier: "free",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
		catalogId: "google",
		keyUrl: "https://aistudio.google.com/apikey",
		keyHint: "AIza…",
		defaultModel: "gemini-2.5-flash",
	},
	{
		id: "mistral",
		name: "Mistral",
		tier: "free",
		baseUrl: "https://api.mistral.ai/v1",
		catalogId: "mistral",
		keyUrl: "https://console.mistral.ai/api-keys",
		keyHint: "32 characters",
		defaultModel: "mistral-small-latest",
	},
	{
		id: "openrouter",
		name: "OpenRouter",
		tier: "free",
		baseUrl: "https://openrouter.ai/api/v1",
		catalogId: "openrouter",
		keyUrl: "https://openrouter.ai/settings/keys",
		keyHint: "sk-or-…",
		freeModel: (id) => id.endsWith(":free"),
	},
	{
		id: "nvidia",
		name: "NVIDIA NIM",
		tier: "free",
		baseUrl: "https://integrate.api.nvidia.com/v1",
		catalogId: "nvidia",
		keyUrl: "https://build.nvidia.com",
		keyHint: "nvapi-…",
		defaultModel: "meta/llama-3.3-70b-instruct",
	},
	{
		id: "huggingface",
		name: "Hugging Face",
		tier: "free",
		baseUrl: "https://router.huggingface.co/v1",
		catalogId: "huggingface",
		keyUrl: "https://huggingface.co/settings/tokens",
		keyHint: "hf_…",
	},
	{
		id: "cloudflare",
		name: "Cloudflare Workers AI",
		tier: "free",
		baseUrl: "https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1",
		catalogId: "cloudflare-workers-ai",
		keyUrl: "https://dash.cloudflare.com/profile/api-tokens",
		keyHint: "account-id:api-token",
		defaultModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
		staticModels: [
			"@cf/meta/llama-3.3-70b-instruct-fp8-fast",
			"@cf/openai/gpt-oss-120b",
			"@cf/qwen/qwen2.5-coder-32b-instruct",
			"@cf/mistralai/mistral-small-3.1-24b-instruct",
		],
	},
	{
		id: "custom",
		name: "OpenAI-compatible server",
		tier: "free",
		baseUrl: "",
		keyHint: "optional",
		customBaseUrl: true,
	},
	{
		id: "openai",
		name: "OpenAI",
		tier: "paid",
		baseUrl: "https://api.openai.com/v1",
		catalogId: "openai",
		keyUrl: "https://platform.openai.com/api-keys",
		keyHint: "sk-…",
		defaultModel: "gpt-5-mini",
	},
	{
		id: "anthropic",
		name: "Anthropic",
		tier: "paid",
		baseUrl: "https://api.anthropic.com/v1",
		catalogId: "anthropic",
		keyUrl: "https://console.anthropic.com/settings/keys",
		keyHint: "sk-ant-…",
		defaultModel: "claude-sonnet-4-5",
	},
] as const satisfies readonly AiProviderDef[];

export type AiProviderId = (typeof aiProviders)[number]["id"];
export const aiProviderIds = aiProviders.map((p) => p.id) as [
	AiProviderId,
	...AiProviderId[],
];

export function aiProvider(id: string): AiProviderDef | undefined {
	return (aiProviders as readonly AiProviderDef[]).find((p) => p.id === id);
}

/** Splits a Cloudflare `account:token` key; other providers use the key as the bearer token. */
export function upstreamAuth(
	provider: AiProviderDef,
	key: string,
	baseUrl?: string | null,
): { baseUrl: string; headers: Record<string, string> } {
	let base = provider.customBaseUrl ? (baseUrl ?? "") : provider.baseUrl;
	let token = key;
	if (provider.id === "cloudflare") {
		const at = key.indexOf(":");
		base = base.replace("{account}", encodeURIComponent(key.slice(0, at)));
		token = key.slice(at + 1);
	}
	const headers: Record<string, string> = {};
	if (token) headers.authorization = `Bearer ${token}`;
	if (provider.id === "anthropic") {
		headers["x-api-key"] = token;
		headers["anthropic-version"] = "2023-06-01";
	}
	if (provider.id === "openrouter") {
		headers["http-referer"] = "https://stack.logicaltech.it";
		headers["x-title"] = "LogiStack";
	}
	return { baseUrl: base.replace(/\/+$/, ""), headers };
}

/** Model ids as the provider's `/models` lists them, kept to the ones its tier serves. */
export function servedModels(provider: AiProviderDef, listed: string[]) {
	const ids = (listed.length ? listed : (provider.staticModels ?? [])).map(
		(id) => id.replace(/^models\//, ""),
	);
	const free = provider.freeModel;
	return [...new Set(free ? ids.filter(free) : ids)].sort();
}

/**
 * `provider/model` pins a provider; a bare model id matches any provider serving it.
 * `auto` (or `auto:free`) is the free chain. Provider ids never contain a slash, model ids may.
 */
export type ModelRef =
	| { kind: "auto" }
	| { kind: "pinned"; provider: string; model: string }
	| { kind: "any"; model: string };

export function parseModelRef(model: string): ModelRef {
	const m = model.trim();
	if (m === "" || m === "auto" || m === "auto:free") return { kind: "auto" };
	const slash = m.indexOf("/");
	if (slash > 0 && aiProvider(m.slice(0, slash)))
		return {
			kind: "pinned",
			provider: m.slice(0, slash),
			model: m.slice(slash + 1),
		};
	return { kind: "any", model: m };
}
