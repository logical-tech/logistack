/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_API_MOCK?: "0" | "1";
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
