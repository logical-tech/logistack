import { isMock } from "./api";
import { authClient } from "./auth";

/** The signed-in person's own security settings: two-factor, passkeys, sessions. */

export type Passkey = {
	id: string;
	name: string | null;
	deviceType: string;
	backedUp: boolean;
	createdAt: string | null;
};

export type SessionRow = {
	id: string;
	token: string;
	userAgent: string | null;
	ipAddress: string | null;
	createdAt: string;
	updatedAt: string;
	current: boolean;
};

export type TwoFactorSetup = { totpURI: string; backupCodes: string[] };

type AccountPort = {
	twoFactorEnabled(): Promise<boolean>;
	enableTwoFactor(password: string): Promise<TwoFactorSetup>;
	verifyTotp(code: string): Promise<void>;
	disableTwoFactor(password: string): Promise<void>;
	listPasskeys(): Promise<Passkey[]>;
	addPasskey(name: string): Promise<void>;
	deletePasskey(id: string): Promise<void>;
	listSessions(): Promise<SessionRow[]>;
	revokeSession(token: string): Promise<void>;
	revokeOtherSessions(): Promise<void>;
};

/** better-auth answers `{ data, error }`; turn the error into a throw for react-query. */
async function unwrap<T>(
	pending: Promise<{ data: T | null; error: { message?: string } | null }>,
	fallback: string,
): Promise<T> {
	const { data, error } = await pending;
	if (error) throw new Error(error.message || fallback);
	return data as T;
}

const iso = (d: Date | string | null | undefined) =>
	d ? new Date(d).toISOString() : null;

const httpAccount: AccountPort = {
	async twoFactorEnabled() {
		const { data } = await authClient.getSession();
		return Boolean(
			(data?.user as { twoFactorEnabled?: boolean } | undefined)
				?.twoFactorEnabled,
		);
	},
	async enableTwoFactor(password) {
		const res = await unwrap(
			authClient.twoFactor.enable({ password }),
			"That password didn't work.",
		);
		if (!("totpURI" in res))
			throw new Error("This server sends codes by email, not an app.");
		return { totpURI: res.totpURI, backupCodes: res.backupCodes };
	},
	async verifyTotp(code) {
		await unwrap(
			authClient.twoFactor.verifyTotp({ code }),
			"That code didn't work.",
		);
	},
	async disableTwoFactor(password) {
		await unwrap(
			authClient.twoFactor.disable({ password }),
			"That password didn't work.",
		);
	},
	async listPasskeys() {
		const rows = await unwrap(
			authClient.passkey.listUserPasskeys(),
			"Couldn't load passkeys.",
		);
		return (rows ?? []).map((p) => ({
			id: p.id,
			name: p.name ?? null,
			deviceType: p.deviceType,
			backedUp: p.backedUp,
			createdAt: iso(p.createdAt),
		}));
	},
	async addPasskey(name) {
		const res = await authClient.passkey.addPasskey({ name });
		if (res?.error) throw new Error(res.error.message || "Passkey not added.");
	},
	async deletePasskey(id) {
		await unwrap(
			authClient.passkey.deletePasskey({ id }),
			"Couldn't remove the passkey.",
		);
	},
	async listSessions() {
		const [sessions, current] = await Promise.all([
			unwrap(authClient.listSessions(), "Couldn't load sessions."),
			authClient.getSession(),
		]);
		const token = current.data?.session.token;
		return (sessions ?? []).map((s) => ({
			id: s.id,
			token: s.token,
			userAgent: s.userAgent ?? null,
			ipAddress: s.ipAddress ?? null,
			createdAt: iso(s.createdAt) ?? "",
			updatedAt: iso(s.updatedAt) ?? "",
			current: s.token === token,
		}));
	},
	async revokeSession(token) {
		await unwrap(
			authClient.revokeSession({ token }),
			"Couldn't sign that session out.",
		);
	},
	async revokeOtherSessions() {
		await unwrap(
			authClient.revokeOtherSessions(),
			"Couldn't sign the other sessions out.",
		);
	},
};

// Mock: every state is reachable. Password "wrong-password" and code "000000" fail.
const wait = (ms = 450) => new Promise((r) => setTimeout(r, ms));
const minutesAgo = (m: number) =>
	new Date(Date.now() - m * 60_000).toISOString();
const mock = {
	twoFactor: false,
	passkeys: [
		{
			id: "pk_mac",
			name: "MacBook Pro Touch ID",
			deviceType: "multiDevice",
			backedUp: true,
			createdAt: minutesAgo(60 * 24 * 41),
		},
		{
			id: "pk_yubi",
			name: "YubiKey 5C",
			deviceType: "singleDevice",
			backedUp: false,
			createdAt: minutesAgo(60 * 24 * 120),
		},
	] as Passkey[],
	sessions: [
		{
			id: "ses_here",
			token: "tok_here",
			userAgent:
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
			ipAddress: "93.44.120.18",
			createdAt: minutesAgo(60 * 26),
			updatedAt: minutesAgo(1),
			current: true,
		},
		{
			id: "ses_phone",
			token: "tok_phone",
			userAgent:
				"Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Mobile/15E148 Safari/604.1",
			ipAddress: "5.90.14.211",
			createdAt: minutesAgo(60 * 24 * 3),
			updatedAt: minutesAgo(60 * 5),
			current: false,
		},
		{
			id: "ses_linux",
			token: "tok_linux",
			userAgent:
				"Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0",
			ipAddress: "51.15.2.200",
			createdAt: minutesAgo(60 * 24 * 9),
			updatedAt: minutesAgo(60 * 24 * 2),
			current: false,
		},
	] as SessionRow[],
};
const checkPassword = (password: string) => {
	if (password.length < 8 || password === "wrong-password")
		throw new Error("That password doesn't match your account.");
};

const mockAccount: AccountPort = {
	async twoFactorEnabled() {
		await wait(150);
		return mock.twoFactor;
	},
	async enableTwoFactor(password) {
		await wait();
		checkPassword(password);
		return {
			totpURI:
				"otpauth://totp/LogiStack:simone%40logical.it?secret=JBSWY3DPEHPK3PXPJ5QWY4TFMNXW4ZDF&issuer=LogiStack&digits=6&period=30",
			backupCodes: [
				"k3d9f-2mx7q",
				"p8r2t-6vn4c",
				"w5h1j-9bz3s",
				"a7c4e-1qk8m",
				"t2n6y-4xw9d",
				"g9m3p-7rf2h",
				"z4b8v-3ls6k",
				"e1q7w-8tj5n",
				"u6x2r-5cd9a",
				"h3k5m-2pz7e",
			],
		};
	},
	async verifyTotp(code) {
		await wait();
		if (code === "000000")
			throw new Error("That code has expired. Enter the current one.");
		mock.twoFactor = true;
	},
	async disableTwoFactor(password) {
		await wait();
		checkPassword(password);
		mock.twoFactor = false;
	},
	async listPasskeys() {
		await wait(200);
		return structuredClone(mock.passkeys);
	},
	async addPasskey(name) {
		await wait(900);
		mock.passkeys.unshift({
			id: `pk_${Math.random().toString(36).slice(2, 8)}`,
			name,
			deviceType: "multiDevice",
			backedUp: true,
			createdAt: new Date().toISOString(),
		});
	},
	async deletePasskey(id) {
		await wait();
		mock.passkeys = mock.passkeys.filter((p) => p.id !== id);
	},
	async listSessions() {
		await wait(200);
		return structuredClone(mock.sessions);
	},
	async revokeSession(token) {
		await wait();
		mock.sessions = mock.sessions.filter((s) => s.token !== token);
	},
	async revokeOtherSessions() {
		await wait();
		mock.sessions = mock.sessions.filter((s) => s.current);
	},
};

export const account: AccountPort = isMock ? mockAccount : httpAccount;

/** "Chrome on macOS", "Safari on iPhone"; good enough for a session list. */
export function describeAgent(ua: string | null): string {
	if (!ua) return "Unknown device";
	if (ua.startsWith("logistack-mcp")) return "MCP client";
	const browser = /Edg\//.test(ua)
		? "Edge"
		: /Firefox\//.test(ua)
			? "Firefox"
			: /Chrome\//.test(ua)
				? "Chrome"
				: /Safari\//.test(ua)
					? "Safari"
					: /curl\//.test(ua)
						? "curl"
						: "Browser";
	const os = /iPhone/.test(ua)
		? "iPhone"
		: /iPad/.test(ua)
			? "iPad"
			: /Android/.test(ua)
				? "Android"
				: /Mac OS X|Macintosh/.test(ua)
					? "macOS"
					: /Windows/.test(ua)
						? "Windows"
						: /Linux/.test(ua)
							? "Linux"
							: null;
	return os ? `${browser} on ${os}` : browser;
}

/** The base32 secret inside an `otpauth://` URI, for manual entry. */
export const totpSecret = (uri: string) =>
	URL.parse(uri)?.searchParams.get("secret") ?? "";
