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
	/** AES-256-GCM over each stored value; the key's 32 characters are its bytes. */
	encryption_key?: string;
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
	/** Peers whose X-Forwarded-For sets `client_ip`; strict reads the header right to left. */
	trusted_proxies?: { source: "static"; ranges: string[] };
	trusted_proxies_strict?: 1;
};

export type CaddyRoute = {
	"@id"?: string;
	match?: CaddyMatcher[];
	handle: CaddyHandler[];
	terminal?: boolean;
};

export type CaddyMatcher = {
	host?: string[];
	path?: string[];
	/** The connection's address, after listener wrappers such as PROXY protocol. */
	remote_ip?: { ranges: string[] };
	/** The address the server's `trusted_proxies` derive from X-Forwarded-For. */
	client_ip?: { ranges: string[] };
	/** True when none of its matcher sets match. */
	not?: CaddyMatcher[];
	vars?: Record<string, string[]>;
};

export type CaddyHeaderOps = {
	set?: Record<string, string[]>;
	delete?: string[];
};

export type CaddyHandler =
	| {
			handler: "reverse_proxy";
			upstreams: { dial: string }[];
			load_balancing?: { try_duration: string; try_interval: string };
			transport?: { protocol: "http"; tls?: Record<string, never> };
			rewrite?: { method?: string; uri?: string };
			headers?: { request?: CaddyHeaderOps };
			handle_response?: {
				match?: { status_code: number[] };
				routes: CaddyRoute[];
			}[];
	  }
	| { handler: "subroute"; routes: CaddyRoute[] }
	| { handler: "headers"; request: CaddyHeaderOps }
	| { handler: "vars" }
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
