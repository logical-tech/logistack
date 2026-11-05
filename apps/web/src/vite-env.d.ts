/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_API_MOCK?: "0" | "1";
	/** The mock migration's source: `coolify` walks the Coolify flow. */
	readonly VITE_MOCK_SOURCE?: "dokploy" | "coolify";
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
