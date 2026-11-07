/** Where a model's spend is counted: `free` providers against the free cap, `paid` against the paid one. */
export type AiTier = "free" | "paid";

/** One published free-tier limit, e.g. 1M tokens per day per account. */
export type AiAllowance = {
	amount: number;
	unit: "tokens" | "requests" | "neurons" | "usd";
	per: "minute" | "hour" | "day" | "month";
	/** What the limit is counted on; `model` limits apply to each model separately. */
	scope?: "account" | "model" | "ip";
};

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
	/** Works without a key (anonymous, rate-limited per IP). */
	keyless?: boolean;
	/** Sent on every call; some gateways refuse requests without a browser-like User-Agent. */
	headers?: Record<string, string>;
	/** Tried first by `auto` when the provider's model list is not loaded yet. */
	defaultModel?: string;
	/** Only these model ids count as free; others are hidden. Absent: every model is free. */
	freeModel?: (id: string) => boolean;
	/** Models served when the provider has no usable `/models` listing. */
	staticModels?: string[];
	/** Rejects JSON Schema keywords like `additionalProperties` in tool parameters; the gateway strips them. */
	plainToolSchemas?: boolean;
	/** Each key carries its own base URL (Ollama, vLLM, LM Studio). */
	customBaseUrl?: boolean;
	/** The free tier as the provider publishes it. Absent: unpublished. Providers change these often. */
	freeQuota?: { limits: AiAllowance[]; note?: string; docsUrl?: string };
};

const suffixFree = (id: string) => id.endsWith(":free");

/**
 * Providers that speak the OpenAI chat API. Every request goes through `/chat/completions`;
 * Anthropic and OpenAI also get their native APIs passed through. Left out on purpose: services
 * reached only by impersonating another client (subscription logins, CLI tokens, web sessions).
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
		freeQuota: {
			limits: [
				{ amount: 100_000, unit: "tokens", per: "day", scope: "model" },
				{ amount: 1_000, unit: "requests", per: "day", scope: "model" },
			],
			note: "Figures for llama-3.3-70b-versatile; every model has its own limits.",
			docsUrl: "https://console.groq.com/docs/rate-limits",
		},
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
		freeQuota: {
			limits: [
				{ amount: 1_000_000, unit: "tokens", per: "day", scope: "model" },
			],
			docsUrl: "https://inference-docs.cerebras.ai/support/rate-limits",
		},
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
		freeQuota: {
			limits: [{ amount: 250, unit: "requests", per: "day", scope: "model" }],
			note: "Figure for gemini-2.5-flash; Pro and Flash-Lite differ.",
			docsUrl: "https://ai.google.dev/gemini-api/docs/rate-limits",
		},
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
		freeQuota: {
			limits: [],
			note: "Free Experiment plan; limits are shown per workspace in the console.",
			docsUrl: "https://admin.mistral.ai/plateforme/limits",
		},
	},
	{
		id: "openrouter",
		name: "OpenRouter",
		tier: "free",
		baseUrl: "https://openrouter.ai/api/v1",
		catalogId: "openrouter",
		keyUrl: "https://openrouter.ai/settings/keys",
		keyHint: "sk-or-…",
		headers: {
			"http-referer": "https://stack.logicaltech.it",
			"x-title": "LogiStack",
		},
		freeModel: suffixFree,
		freeQuota: {
			limits: [{ amount: 50, unit: "requests", per: "day" }],
			note: "1,000 requests a day once the account has bought $10 of credits.",
			docsUrl: "https://openrouter.ai/docs/api-reference/limits",
		},
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
		freeQuota: { limits: [{ amount: 40, unit: "requests", per: "minute" }] },
	},
	{
		id: "huggingface",
		name: "Hugging Face",
		tier: "free",
		baseUrl: "https://router.huggingface.co/v1",
		catalogId: "huggingface",
		keyUrl: "https://huggingface.co/settings/tokens",
		keyHint: "hf_…",
		freeQuota: {
			limits: [{ amount: 0.1, unit: "usd", per: "month" }],
			note: "Monthly inference credits on free accounts.",
			docsUrl: "https://huggingface.co/docs/inference-providers/pricing",
		},
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
		freeQuota: {
			limits: [{ amount: 10_000, unit: "neurons", per: "day" }],
			docsUrl: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
		},
	},
	{
		id: "ollama",
		name: "Ollama Cloud",
		tier: "free",
		baseUrl: "https://ollama.com/v1",
		keyUrl: "https://ollama.com/settings/keys",
		keyHint: "Ollama API key",
	},
	{
		id: "kilo",
		name: "Kilo Gateway",
		tier: "free",
		baseUrl: "https://api.kilo.ai/api/gateway/v1",
		keyUrl: "https://kilo.ai",
		keyHint: "not needed",
		keyless: true,
		freeModel: suffixFree,
		freeQuota: {
			limits: [{ amount: 200, unit: "requests", per: "hour", scope: "ip" }],
		},
	},
	{
		id: "llm7",
		name: "LLM7",
		tier: "free",
		baseUrl: "https://api.llm7.io/v1",
		keyUrl: "https://token.llm7.io",
		keyHint: "optional",
		keyless: true,
		freeQuota: { limits: [{ amount: 100, unit: "requests", per: "hour" }] },
	},
	{
		id: "ovh",
		name: "OVHcloud AI Endpoints",
		tier: "free",
		baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
		keyUrl: "https://endpoints.ai.cloud.ovh.net",
		keyHint: "not needed",
		keyless: true,
		freeQuota: {
			limits: [{ amount: 2, unit: "requests", per: "minute", scope: "model" }],
			note: "Anonymous access, counted per IP.",
		},
	},
	{
		id: "siliconflow",
		name: "SiliconFlow",
		tier: "free",
		baseUrl: "https://api.siliconflow.com/v1",
		catalogId: "siliconflow",
		keyUrl: "https://cloud.siliconflow.com/account/ak",
		keyHint: "sk-…",
	},
	{
		id: "routeway",
		name: "Routeway",
		tier: "free",
		baseUrl: "https://api.routeway.ai/v1",
		keyUrl: "https://routeway.ai",
		keyHint: "sk-…",
		headers: { "user-agent": "Mozilla/5.0 LogiStack/1.0" },
		freeModel: suffixFree,
	},
	{
		id: "unorouter",
		name: "UnoRouter",
		tier: "free",
		baseUrl: "https://api.unorouter.com/v1",
		keyUrl: "https://unorouter.com",
		keyHint: "API key",
		freeModel: suffixFree,
	},
	{
		id: "orcarouter",
		name: "OrcaRouter",
		tier: "free",
		baseUrl: "https://api.orcarouter.ai/v1",
		keyUrl: "https://orcarouter.ai",
		keyHint: "API key",
		freeModel: (id) => id.endsWith("-free") || id === "orcarouter/free",
	},
	{
		id: "requesty",
		name: "Requesty",
		tier: "free",
		baseUrl: "https://router.requesty.ai/v1",
		keyUrl: "https://app.requesty.ai",
		keyHint: "API key",
	},
	{
		id: "navy",
		name: "NavyAI",
		tier: "free",
		baseUrl: "https://api.navy/v1",
		keyUrl: "https://api.navy",
		keyHint: "sk-navy-…",
		headers: { "user-agent": "LogiStack/1.0" },
		freeQuota: {
			limits: [
				{ amount: 150_000, unit: "tokens", per: "day" },
				{ amount: 20, unit: "requests", per: "minute" },
			],
		},
	},
	{
		id: "xkiro",
		name: "xKiro",
		tier: "free",
		baseUrl: "https://api.xkiro.com/v1",
		keyUrl: "https://xkiro.com",
		keyHint: "API key",
		freeQuota: { limits: [{ amount: 5_000_000, unit: "tokens", per: "day" }] },
	},
	{
		id: "anyapi",
		name: "AnyAPI",
		tier: "free",
		baseUrl: "https://api.anyapi.ai/v1",
		keyUrl: "https://anyapi.ai",
		keyHint: "API key",
		freeQuota: { limits: [{ amount: 100_000, unit: "tokens", per: "day" }] },
	},
	{
		id: "sealion",
		name: "SEA-LION",
		tier: "free",
		baseUrl: "https://api.sea-lion.ai/v1",
		keyUrl: "https://playground.sea-lion.ai",
		keyHint: "sk-…",
		freeQuota: { limits: [{ amount: 10, unit: "requests", per: "minute" }] },
	},
	{
		id: "longcat",
		name: "LongCat",
		tier: "free",
		baseUrl: "https://api.longcat.chat/openai/v1",
		keyUrl: "https://longcat.chat/platform",
		keyHint: "ak_…",
		freeQuota: {
			limits: [],
			note: "Daily free quota, shown in the LongCat console.",
		},
	},
	{
		id: "zhipu",
		name: "Z.ai (GLM)",
		tier: "free",
		baseUrl: "https://api.z.ai/api/paas/v4",
		catalogId: "zai",
		keyUrl: "https://z.ai/manage-apikey/apikey-list",
		keyHint: "API key",
		defaultModel: "glm-4.5-flash",
		// Only the Flash models are free; the rest bill the account.
		freeModel: (id) => /flash/i.test(id),
	},
	{
		id: "modelscope",
		name: "ModelScope",
		tier: "free",
		baseUrl: "https://api-inference.modelscope.cn/v1",
		keyUrl: "https://modelscope.cn/my/myaccesstoken",
		keyHint: "ms-…",
		freeQuota: {
			limits: [],
			note: "Daily allowance per account; needs an Alibaba Cloud account binding.",
		},
	},
	{
		id: "aion",
		name: "Aion Labs",
		tier: "free",
		baseUrl: "https://api.aionlabs.ai/v1",
		keyUrl: "https://aionlabs.ai",
		keyHint: "API key",
	},
	{
		id: "cohere",
		name: "Cohere",
		tier: "free",
		baseUrl: "https://api.cohere.ai/compatibility/v1",
		catalogId: "cohere",
		keyUrl: "https://dashboard.cohere.com/api-keys",
		keyHint: "trial key",
		defaultModel: "command-a-03-2025",
		plainToolSchemas: true,
		freeQuota: {
			limits: [{ amount: 1_000, unit: "requests", per: "month" }],
			note: "Trial keys are for evaluation; Cohere's terms don't allow production use.",
			docsUrl: "https://docs.cohere.com/docs/rate-limits",
		},
	},
	{
		id: "custom",
		name: "OpenAI-compatible server",
		tier: "free",
		baseUrl: "",
		keyHint: "optional",
		keyless: true,
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
	{
		id: "deepseek",
		name: "DeepSeek",
		tier: "paid",
		baseUrl: "https://api.deepseek.com/v1",
		catalogId: "deepseek",
		keyUrl: "https://platform.deepseek.com/api_keys",
		keyHint: "sk-…",
		defaultModel: "deepseek-chat",
	},
	{
		id: "xai",
		name: "xAI",
		tier: "paid",
		baseUrl: "https://api.x.ai/v1",
		catalogId: "xai",
		keyUrl: "https://console.x.ai",
		keyHint: "xai-…",
	},
	{
		id: "together",
		name: "Together AI",
		tier: "paid",
		baseUrl: "https://api.together.xyz/v1",
		catalogId: "togetherai",
		keyUrl: "https://api.together.ai/settings/api-keys",
		keyHint: "API key",
	},
	{
		id: "fireworks",
		name: "Fireworks AI",
		tier: "paid",
		baseUrl: "https://api.fireworks.ai/inference/v1",
		catalogId: "fireworks-ai",
		keyUrl: "https://fireworks.ai/account/api-keys",
		keyHint: "fw_…",
	},
	{
		id: "sambanova",
		name: "SambaNova",
		tier: "paid",
		baseUrl: "https://api.sambanova.ai/v1",
		catalogId: "sambanova",
		keyUrl: "https://cloud.sambanova.ai/apis",
		keyHint: "API key",
		defaultModel: "Meta-Llama-3.3-70B-Instruct",
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

/**
 * A free tier as per-day totals: hour limits ×24, month limits ÷30. Minute limits are throughput,
 * not a daily allowance, so they are left out; `model` limits count once (the default model's).
 */
export function dailyAllowance(limits: readonly AiAllowance[]) {
	const perDay = (a: AiAllowance) =>
		a.per === "day"
			? a.amount
			: a.per === "hour"
				? a.amount * 24
				: a.per === "month"
					? a.amount / 30
					: 0;
	const sum = (unit: AiAllowance["unit"]) =>
		limits.filter((a) => a.unit === unit).reduce((n, a) => n + perDay(a), 0);
	return { tokens: sum("tokens"), requests: sum("requests") };
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
	Object.assign(headers, provider.headers);
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

export type UpstreamFailure =
	/** The client's request is wrong; another provider would refuse it too. */
	| "request"
	/** Out of quota or rate limited: back off this key and model, try the next. */
	| "quota"
	/** An outage or timeout: a short pause, try the next. */
	| "transient"
	/** The key is revoked or wrong: take it out until it is tested again. */
	| "auth"
	/** This provider lacks the model: try the next without penalty. */
	| "missing";

const QUOTA_TEXT =
	/rate.?limit|too many requests|quota|insufficient.{0,12}(credit|balance|quota)|credit balance|limit (reached|exceeded)|free.?tier/i;

/** What a non-2xx upstream answer means for routing. Providers hide quota errors behind 400 and 403 too. */
export function classifyFailure(
	status: number,
	message: string,
): UpstreamFailure {
	if (status === 429 || status === 402) return "quota";
	if (status === 404) return "missing";
	if (status === 408 || status === 409 || status >= 500) return "transient";
	if (QUOTA_TEXT.test(message)) return "quota";
	if (status === 401 || status === 403) return "auth";
	return "request";
}

/** Exponential back-off for repeated quota errors: 2 s, 4 s, … capped at 5 minutes. */
export const backoffSeconds = (level: number) =>
	Math.min(2 * 2 ** Math.max(0, level - 1), 300);
