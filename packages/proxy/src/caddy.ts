// Hand-written subset of the Caddy 2.11 JSON config that compileProxy emits.
// Reference: https://caddyserver.com/docs/json/

export type CaddyConfig = {
	admin: { listen: string };
	logging: { logs: Record<string, CaddyLog> };
	storage: CaddyRedisStorage;
	apps: { http: CaddyHttpApp; tls: CaddyTlsApp };
};

export type CaddyLog = {
	writer: { output: "stdout" | "stderr" };
	encoder: { format: "json" };
	include?: string[];
	exclude?: string[];
};

/** pberkel/caddy-storage-redis, module id `caddy.storage.redis`. */
export type CaddyRedisStorage = {
	module: "redis";
	address: string[];
	username?: string;
	password?: string;
	db: number;
	key_prefix: string;
	tls_enabled: boolean;
};

export type CaddyHttpApp = {
	http_port: number;
	https_port: number;
	/** Go duration string. Time old connections get to finish after a config change. */
	grace_period: string;
	servers: Record<string, CaddyServer>;
};

export type CaddyServer = {
	listen: string[];
	routes: CaddyRoute[];
	automatic_https?: {
		disable?: boolean;
		disable_redirects?: boolean;
	};
	logs?: { default_logger_name: string };
};

export type CaddyRoute = {
	"@id"?: string;
	match?: CaddyMatcher[];
	handle: CaddyHandler[];
	terminal?: boolean;
};

export type CaddyMatcher = { host?: string[]; path?: string[] };

export type CaddyHandler =
	| { handler: "reverse_proxy"; upstreams: { dial: string }[] }
	| {
			handler: "authentication";
			providers: {
				http_basic: {
					accounts: { username: string; password: string }[];
					hash: { algorithm: "bcrypt" };
					realm?: string;
				};
			};
	  }
	| {
			handler: "static_response";
			status_code: number;
			headers?: Record<string, string[]>;
			body?: string;
	  };

export type CaddyTlsApp = {
	certificates?: { load_pem: CaddyLoadedPem[] };
	automation: { policies: CaddyAutomationPolicy[] };
};

export type CaddyLoadedPem = {
	certificate: string;
	key: string;
	tags: string[];
};

export type CaddyAutomationPolicy = {
	/** Omitted on the catch-all policy, which applies to every other subject. */
	subjects?: string[];
	issuers: CaddyIssuer[];
};

export type CaddyIssuer =
	| {
			module: "acme";
			ca?: string;
			email: string;
			external_account?: { key_id: string; mac_key: string };
			challenges?: {
				dns: { provider: { name: string } & Record<string, string> };
			};
	  }
	| { module: "internal" };
