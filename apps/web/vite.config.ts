import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The API server the dev proxy forwards to; the e2e script points it at its own server.
const api = process.env.LOGISTACK_API ?? "http://localhost:3000";

export default defineConfig({
	plugins: [
		tanstackRouter({ target: "react", autoCodeSplitting: true }),
		react(),
		tailwindcss(),
	],
	resolve: {
		alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
	},
	server: {
		port: 5173,
		proxy: {
			"/api": api,
			"/ws": { target: api.replace(/^http/, "ws"), ws: true },
		},
	},
});
