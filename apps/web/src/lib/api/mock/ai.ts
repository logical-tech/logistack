import { ApiError } from "../adapter";
import type {
	AiApi,
	AiBudget,
	AiFigures,
	AiGatewayKey,
	AiModel,
	AiProviderDef,
	AiProviderKey,
	AiSettings,
	AiUsage,
	AiUsageRange,
} from "../ai";

/**
 * `ls-mock-ai=member` shows the page as a member without admin rights;
 * `ls-mock-ai=none` as someone whose role lacks the `ai` permission.
 */
const mode = localStorage.getItem("ls-mock-ai");
const admin = mode !== "member";

const delay = <T>(v: T, ms = 180 + Math.random() * 260) =>
	new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));
const fail = (status: number, message: string, code: string) =>
	Promise.reject(new ApiError(status, message, code));
const guard = () =>
	mode === "none"
		? fail(403, "Your role doesn't include AI access.", "forbidden")
		: null;
const adminOnly = () =>
	guard() ??
	(admin ? null : fail(403, "Only admins manage the AI gateway.", "forbidden"));

const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const rid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`;

const PROVIDERS: AiProviderDef[] = [
	[
		"groq",
		"Groq",
		"free",
		"https://console.groq.com/keys",
		"gsk_…",
		"llama-3.3-70b-versatile",
	],
	[
		"cerebras",
		"Cerebras",
		"free",
		"https://cloud.cerebras.ai",
		"csk-…",
		"gpt-oss-120b",
	],
	[
		"gemini",
		"Google Gemini",
		"free",
		"https://aistudio.google.com/apikey",
		"AIza…",
		"gemini-2.5-flash",
	],
	[
		"mistral",
		"Mistral",
		"free",
		"https://console.mistral.ai/api-keys",
		"32 characters",
		"mistral-small-latest",
	],
	[
		"openrouter",
		"OpenRouter",
		"free",
		"https://openrouter.ai/settings/keys",
		"sk-or-…",
		null,
	],
	[
		"nvidia",
		"NVIDIA NIM",
		"free",
		"https://build.nvidia.com",
		"nvapi-…",
		"meta/llama-3.3-70b-instruct",
	],
	[
		"huggingface",
		"Hugging Face",
		"free",
		"https://huggingface.co/settings/tokens",
		"hf_…",
		null,
	],
	[
		"cloudflare",
		"Cloudflare Workers AI",
		"free",
		"https://dash.cloudflare.com/profile/api-tokens",
		"account-id:api-token",
		"@cf/meta/llama-3.3-70b-instruct-fp8-fast",
	],
	["custom", "OpenAI-compatible server", "free", null, "optional", null],
	[
		"openai",
		"OpenAI",
		"paid",
		"https://platform.openai.com/api-keys",
		"sk-…",
		"gpt-5-mini",
	],
	[
		"anthropic",
		"Anthropic",
		"paid",
		"https://console.anthropic.com/settings/keys",
		"sk-ant-…",
		"claude-sonnet-4-5",
	],
].map(([id, name, tier, keyUrl, keyHint, defaultModel]) => ({
	id: id as string,
	name: name as string,
	tier: tier as "free" | "paid",
	keyUrl: keyUrl ?? null,
	keyHint: keyHint as string,
	customBaseUrl: id === "custom",
	defaultModel: defaultModel ?? null,
}));
const def = (id: string) => PROVIDERS.find((p) => p.id === id);

/** What each provider's key serves once tested. */
const SERVED: Record<string, string[]> = {
	groq: [
		"llama-3.3-70b-versatile",
		"llama-3.1-8b-instant",
		"openai/gpt-oss-120b",
		"qwen/qwen3-32b",
		"moonshotai/kimi-k2-instruct",
	],
	cerebras: ["gpt-oss-120b", "llama-3.3-70b", "qwen-3-235b-a22b-instruct"],
	gemini: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"],
	mistral: [
		"mistral-small-latest",
		"mistral-medium-latest",
		"codestral-latest",
	],
	openrouter: [
		"deepseek/deepseek-chat-v3.1:free",
		"meta-llama/llama-3.3-70b-instruct:free",
		"qwen/qwen3-coder:free",
	],
	nvidia: ["meta/llama-3.3-70b-instruct", "deepseek-ai/deepseek-r1"],
	huggingface: ["meta-llama/Llama-3.3-70B-Instruct", "Qwen/Qwen3-32B"],
	cloudflare: [
		"@cf/meta/llama-3.3-70b-instruct-fp8-fast",
		"@cf/openai/gpt-oss-120b",
		"@cf/qwen/qwen2.5-coder-32b-instruct",
	],
	custom: ["llama3.2:3b", "qwen2.5-coder:7b"],
	openai: ["gpt-5", "gpt-5-mini", "gpt-5-nano", "text-embedding-3-small"],
	anthropic: ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1"],
};

/** Market USD per 1M tokens (input, output); unknown models have no price. */
const PRICE: Record<string, [number, number]> = {
	"llama-3.3-70b-versatile": [0.59, 0.79],
	"llama-3.1-8b-instant": [0.05, 0.08],
	"openai/gpt-oss-120b": [0.15, 0.75],
	"gpt-oss-120b": [0.25, 0.69],
	"qwen/qwen3-32b": [0.29, 0.59],
	"gemini-2.5-flash": [0.3, 2.5],
	"gemini-2.5-flash-lite": [0.1, 0.4],
	"gemini-2.5-pro": [1.25, 10],
	"mistral-small-latest": [0.1, 0.3],
	"mistral-medium-latest": [0.4, 2],
	"codestral-latest": [0.3, 0.9],
	"deepseek/deepseek-chat-v3.1:free": [0.27, 1.1],
	"meta-llama/llama-3.3-70b-instruct:free": [0.13, 0.4],
	"@cf/meta/llama-3.3-70b-instruct-fp8-fast": [0.29, 2.25],
	"gpt-5": [1.25, 10],
	"gpt-5-mini": [0.25, 2],
	"gpt-5-nano": [0.05, 0.4],
	"text-embedding-3-small": [0.02, 0],
	"claude-sonnet-4-5": [3, 15],
	"claude-haiku-4-5": [1, 5],
	"claude-opus-4-1": [15, 75],
};

const key = (
	provider: string,
	label: string,
	age: number,
	extra: Partial<AiProviderKey> = {},
): AiProviderKey => ({
	id: rid("aik"),
	provider,
	label,
	baseUrl: null,
	enabled: true,
	status: "healthy",
	lastError: null,
	lastCheckedAt: ago(6 * 60_000),
	models: SERVED[provider] ?? [],
	createdAt: ago(age * DAY),
	...extra,
});

let keys: AiProviderKey[] = [
	key("groq", "Groq", 41),
	key("cerebras", "Cerebras", 38),
	key("gemini", "Gemini, personal", 33),
	key("openrouter", "OpenRouter", 21),
	key("mistral", "Mistral", 12, {
		status: "unhealthy",
		lastError: "401 Unauthorized: API key revoked or expired",
		lastCheckedAt: ago(3 * 60 * 60_000),
		models: [],
	}),
	key("custom", "Ollama on gpu-01", 9, {
		baseUrl: "http://10.0.4.12:11434/v1",
		enabled: false,
		status: "unknown",
		lastCheckedAt: null,
		models: [],
	}),
	key("openai", "OpenAI, production", 30),
	key("anthropic", "Anthropic", 17),
];

let settings = {
	gatewayEnabled: true,
	autoChain: [
		"groq/llama-3.3-70b-versatile",
		"cerebras/gpt-oss-120b",
		"gemini/gemini-2.5-flash",
		"openrouter/deepseek/deepseek-chat-v3.1:free",
	],
};

const MEMBERS = [
	{
		userId: "usr_owner",
		name: "Simone Maddiona",
		email: "simone@logicaltech.it",
		role: "owner",
	},
	{
		userId: "usr_giulia",
		name: "Giulia Ferri",
		email: "giulia@logicaltech.it",
		role: "admin",
	},
	{
		userId: "usr_marco",
		name: "Marco Bellini",
		email: "marco@logicaltech.it",
		role: "developer",
	},
	{
		userId: "usr_sara",
		name: "Sara Conti",
		email: "sara@logicaltech.it",
		role: "developer",
	},
	{
		userId: "usr_luca",
		name: "Luca Romano",
		email: "luca@logicaltech.it",
		role: "viewer",
	},
	{
		userId: "usr_bot",
		name: "Support bot",
		email: "bot@logicaltech.it",
		role: "ai-user",
	},
];
const ME = admin ? "usr_owner" : "usr_marco";

const SPENT: Record<string, { free: number; paid: number }> = {
	usr_owner: { free: 2.41, paid: 6.12 },
	usr_giulia: { free: 1.08, paid: 0.74 },
	usr_marco: { free: 1.62, paid: 4.38 },
	usr_bot: { free: 4.05, paid: 8.71 },
};

let budgets: AiBudget[] = MEMBERS.map((m) => {
	const isAdmin = m.role === "owner" || m.role === "admin";
	const hasAi = isAdmin || m.role === "ai-user" || m.userId === "usr_marco";
	const caps =
		m.userId === "usr_owner"
			? { free: null, paid: 50 }
			: m.userId === "usr_marco"
				? { free: 5, paid: 20 }
				: m.userId === "usr_bot"
					? { free: null, paid: 10 }
					: isAdmin
						? { free: null, paid: null }
						: { free: 0, paid: 0 };
	return {
		...m,
		hasAi,
		isAdmin,
		caps,
		inherited: !["usr_owner", "usr_bot", "usr_marco"].includes(m.userId),
		spent: SPENT[m.userId] ?? { free: 0, paid: 0 },
	};
});

let gatewayKeys: AiGatewayKey[] = [
	{
		id: rid("aig"),
		name: "Laptop, Cursor",
		start: "lsai_7hQ2",
		userId: "usr_owner",
		userName: "Simone Maddiona",
		lastUsedAt: ago(14 * 60_000),
		createdAt: ago(28 * DAY),
	},
	{
		id: rid("aig"),
		name: "n8n workflows",
		start: "lsai_Kp9x",
		userId: "usr_owner",
		userName: "Simone Maddiona",
		lastUsedAt: ago(3 * 60 * 60_000),
		createdAt: ago(19 * DAY),
	},
	{
		id: rid("aig"),
		name: "Support bot",
		start: "lsai_c1Vm",
		userId: "usr_bot",
		userName: "Support bot",
		lastUsedAt: ago(40_000),
		createdAt: ago(16 * DAY),
	},
	{
		id: rid("aig"),
		name: "Claude Code",
		start: "lsai_Rr4e",
		userId: "usr_marco",
		userName: "Marco Bellini",
		lastUsedAt: ago(2 * DAY),
		createdAt: ago(9 * DAY),
	},
	{
		id: rid("aig"),
		name: "Old CI key",
		start: "lsai_0bTz",
		userId: "usr_giulia",
		userName: "Giulia Ferri",
		lastUsedAt: null,
		createdAt: ago(44 * DAY),
	},
];

function models(): AiModel[] {
	return keys
		.filter((k) => k.enabled && k.status !== "unhealthy")
		.flatMap((k) =>
			k.models.map((m) => {
				const p = PRICE[m];
				return {
					id: `${k.provider}/${m}`,
					provider: k.provider,
					model: m,
					tier: def(k.provider)?.tier ?? "free",
					price: p ? { input: p[0], output: p[1] } : null,
				};
			}),
		)
		.filter((m, i, all) => all.findIndex((x) => x.id === m.id) === i);
}

/* ---------- usage ---------- */

const STEP: Record<
	AiUsageRange,
	{ n: number; ms: number; step: AiUsage["step"] }
> = {
	"24h": { n: 24, ms: 3_600_000, step: "hour" },
	"7d": { n: 7, ms: DAY, step: "day" },
	"30d": { n: 30, ms: DAY, step: "day" },
	"90d": { n: 13, ms: 7 * DAY, step: "week" },
	"12m": { n: 12, ms: 30 * DAY, step: "month" },
};

/** Deterministic noise so the chart holds still between refetches. */
const noise = (i: number) => {
	const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
	return x - Math.floor(x);
};

const MIX = {
	free: [
		{
			provider: "groq",
			model: "llama-3.3-70b-versatile",
			w: 0.46,
			inTok: 1400,
			outTok: 380,
		},
		{
			provider: "cerebras",
			model: "gpt-oss-120b",
			w: 0.22,
			inTok: 1900,
			outTok: 520,
		},
		{
			provider: "gemini",
			model: "gemini-2.5-flash",
			w: 0.19,
			inTok: 2600,
			outTok: 610,
		},
		{
			provider: "openrouter",
			model: "deepseek/deepseek-chat-v3.1:free",
			w: 0.08,
			inTok: 3100,
			outTok: 900,
		},
		{
			provider: "mistral",
			model: "mistral-small-latest",
			w: 0.05,
			inTok: 900,
			outTok: 240,
		},
	],
	paid: [
		{
			provider: "openai",
			model: "gpt-5-mini",
			w: 0.52,
			inTok: 2100,
			outTok: 640,
		},
		{
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			w: 0.33,
			inTok: 4200,
			outTok: 980,
		},
		{
			provider: "openai",
			model: "text-embedding-3-small",
			w: 0.15,
			inTok: 620,
			outTok: 0,
		},
	],
};

function figures(tier: "free" | "paid", requests: number): AiFigures {
	const f = { requests, inputTokens: 0, outputTokens: 0, cost: 0 };
	for (const m of MIX[tier]) {
		const r = requests * m.w;
		const [pi, po] = PRICE[m.model] ?? [0, 0];
		f.inputTokens += r * m.inTok;
		f.outputTokens += r * m.outTok;
		f.cost += (r * m.inTok * pi + r * m.outTok * po) / 1e6;
	}
	f.inputTokens = Math.round(f.inputTokens);
	f.outputTokens = Math.round(f.outputTokens);
	return f;
}

const add = (a: AiFigures, b: AiFigures): AiFigures => ({
	requests: a.requests + b.requests,
	inputTokens: a.inputTokens + b.inputTokens,
	outputTokens: a.outputTokens + b.outputTokens,
	cost: a.cost + b.cost,
});
const scale = (f: AiFigures, k: number): AiFigures => ({
	requests: Math.round(f.requests * k),
	inputTokens: Math.round(f.inputTokens * k),
	outputTokens: Math.round(f.outputTokens * k),
	cost: f.cost * k,
});
const ZERO: AiFigures = {
	requests: 0,
	inputTokens: 0,
	outputTokens: 0,
	cost: 0,
};

function usage(range: AiUsageRange): AiUsage {
	const { n, ms, step } = STEP[range];
	const to = Date.now();
	const start = Math.floor(to / ms) * ms - (n - 1) * ms;
	// Members see their own slice, roughly a fifth of the organization's.
	const share = admin ? 1 : 0.21;
	const buckets = Array.from({ length: n }, (_, i) => {
		const t = start + i * ms;
		const d = new Date(t);
		// Requests a day: quiet weekends, a slow climb as more people adopt it.
		const weekday = d.getDay() === 0 || d.getDay() === 6 ? 0.42 : 1;
		const growth = 0.7 + (0.3 * i) / n;
		const hourly =
			step === "hour"
				? Math.max(
						0.08,
						Math.sin(((d.getHours() - 7) / 24) * Math.PI * 2) + 0.55,
					) / 20
				: 1;
		const perDay =
			step === "hour" ? 1 : step === "day" ? 1 : step === "week" ? 6 : 26;
		const base =
			perDay * hourly * weekday * growth * (0.82 + noise(i) * 0.36) * share;
		return {
			t: new Date(t).toISOString(),
			free: figures("free", Math.round(base * 640)),
			paid: figures(
				"paid",
				Math.round(base * 160 * (0.8 + noise(i + 99) * 0.5)),
			),
		};
	});
	const free = buckets.reduce((s, b) => add(s, b.free), ZERO);
	const paid = buckets.reduce((s, b) => add(s, b.paid), ZERO);
	const byModel = (["free", "paid"] as const).flatMap((tier) =>
		MIX[tier].map((m) => {
			const r = (tier === "free" ? free : paid).requests * m.w;
			const [pi, po] = PRICE[m.model] ?? [0, 0];
			return {
				provider: m.provider,
				model: m.model,
				tier,
				requests: Math.round(r),
				inputTokens: Math.round(r * m.inTok),
				outputTokens: Math.round(r * m.outTok),
				cost: (r * m.inTok * pi + r * m.outTok * po) / 1e6,
			};
		}),
	);
	const shares: [string, number, number][] = [
		["usr_bot", 0.44, 0.27],
		["usr_owner", 0.24, 0.39],
		["usr_marco", 0.21, 0.29],
		["usr_giulia", 0.11, 0.05],
	];
	return {
		range,
		step,
		from: new Date(start).toISOString(),
		to: new Date(to).toISOString(),
		buckets,
		totals: {
			free,
			paid,
			errors: Math.round((free.requests + paid.requests) * 0.011),
		},
		byModel: byModel.sort((a, b) => b.requests - a.requests),
		byMember: admin
			? shares.map(([userId, f, p]) => ({
					userId,
					name: MEMBERS.find((m) => m.userId === userId)?.name ?? userId,
					free: scale(free, f),
					paid: scale(paid, p),
				}))
			: [],
	};
}

function test(k: AiProviderKey, secret: string): AiProviderKey {
	const bad =
		/invalid|wrong|bad/i.test(secret) ||
		(k.provider !== "custom" && secret.length < 8);
	return {
		...k,
		status: bad ? "unhealthy" : "healthy",
		lastError: bad ? "401 Unauthorized: the provider rejected this key" : null,
		lastCheckedAt: new Date().toISOString(),
		models: bad ? [] : (SERVED[k.provider] ?? []),
	};
}

const secrets = new Map<string, string>(keys.map((k) => [k.id, "ok-secret"]));
for (const k of keys)
	if (k.status === "unhealthy") secrets.set(k.id, "invalid");

function find(id: string) {
	const k = keys.find((x) => x.id === id);
	if (!k) throw new ApiError(404, "provider key not found", "not_found");
	return k;
}
const replace = (k: AiProviderKey) => {
	keys = keys.map((x) => (x.id === k.id ? k : x));
	return k;
};

export const mockAi: AiApi = {
	settings: () =>
		guard() ??
		delay<AiSettings>({
			...settings,
			canAdmin: admin,
			providers: PROVIDERS,
			me: {
				caps: budgets.find((b) => b.userId === ME)?.caps ?? {
					free: 0,
					paid: 0,
				},
				spent: SPENT[ME] ?? { free: 0, paid: 0 },
			},
		}),
	updateSettings: (input) => {
		const denied = adminOnly();
		if (denied) return denied;
		settings = { ...settings, ...input };
		return delay(undefined);
	},
	providerKeys: {
		list: () => adminOnly() ?? delay(keys),
		create: (input) => {
			const denied = adminOnly();
			if (denied) return denied;
			const d = def(input.provider);
			if (!d) return fail(400, "unknown provider", "bad_request");
			if (d.customBaseUrl && !input.baseUrl)
				return fail(400, "a custom server needs its base URL", "bad_request");
			if (!d.customBaseUrl && !input.key)
				return fail(400, `${d.name} needs an API key`, "bad_request");
			if (d.id === "cloudflare" && !/^[^:\s]+:\S+$/.test(input.key ?? ""))
				return fail(
					400,
					"Cloudflare keys are `account-id:api-token`",
					"bad_request",
				);
			const row = test(
				key(input.provider, input.label, 0, {
					baseUrl: d.customBaseUrl ? (input.baseUrl ?? null) : null,
				}),
				input.key ?? "",
			);
			secrets.set(row.id, input.key ?? "");
			keys = [...keys, row];
			return delay(row, 900);
		},
		update: (id, input) => {
			const denied = adminOnly();
			if (denied) return denied;
			const k = find(id);
			if (input.key) secrets.set(id, input.key);
			const next = {
				...k,
				...(input.label !== undefined && { label: input.label }),
				...(input.enabled !== undefined && { enabled: input.enabled }),
			};
			return delay(replace(input.key ? test(next, input.key) : next));
		},
		test: (id) =>
			adminOnly() ?? delay(replace(test(find(id), secrets.get(id) ?? "")), 900),
		remove: (id) => {
			const denied = adminOnly();
			if (denied) return denied;
			keys = keys.filter((k) => k.id !== id);
			return delay(undefined);
		},
	},
	models: () => guard() ?? delay(models()),
	gatewayKeys: {
		list: () =>
			guard() ??
			delay(admin ? gatewayKeys : gatewayKeys.filter((k) => k.userId === ME)),
		create: (name) => {
			const denied = guard();
			if (denied) return denied;
			const secret = `lsai_${crypto.randomUUID().replaceAll("-", "")}`;
			const row: AiGatewayKey = {
				id: rid("aig"),
				name,
				start: secret.slice(0, 9),
				userId: ME,
				userName: MEMBERS.find((m) => m.userId === ME)?.name ?? "You",
				lastUsedAt: null,
				createdAt: new Date().toISOString(),
			};
			gatewayKeys = [row, ...gatewayKeys];
			return delay({ ...row, key: secret });
		},
		remove: (id) => {
			const denied = guard();
			if (denied) return denied;
			gatewayKeys = gatewayKeys.filter((k) => k.id !== id);
			return delay(undefined);
		},
	},
	budgets: {
		list: () => adminOnly() ?? delay(budgets),
		set: (userId, caps) => {
			const denied = adminOnly();
			if (denied) return denied;
			budgets = budgets.map((b) =>
				b.userId === userId ? { ...b, caps, inherited: false } : b,
			);
			return delay(undefined);
		},
	},
	usage: (range) => guard() ?? delay(usage(range)),
};
