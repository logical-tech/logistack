import { apiKeyClient } from "@better-auth/api-key/client";
import { passkeyClient } from "@better-auth/passkey/client";
import {
	organizationClient,
	twoFactorClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { useSyncExternalStore } from "react";
import { isMock } from "./api";

export const authClient = createAuthClient({
	basePath: "/api/auth",
	plugins: [
		twoFactorClient({
			onTwoFactorRedirect: () => {
				window.location.assign("/two-factor");
			},
		}),
		passkeyClient(),
		organizationClient(),
		apiKeyClient(),
	],
});

export type SessionUser = { id: string; name: string; email: string };
export type Org = { id: string; name: string; slug: string };

/** Outcome of a sign-in attempt, so screens branch on one value. */
export type SignInResult =
	| { kind: "signed-in" }
	| { kind: "two-factor" }
	/** The browser is on its way to an identity provider. */
	| { kind: "redirecting" }
	| { kind: "error"; message: string };

type AuthPort = {
	getSession(): Promise<SessionUser | null>;
	signInEmail(input: {
		email: string;
		password: string;
		remember: boolean;
	}): Promise<SignInResult>;
	signInPasskey(): Promise<SignInResult>;
	signInSocial(provider: "github" | "google"): Promise<SignInResult>;
	/** The SSO provider is picked by the email's domain. */
	signInSso(email: string, redirect: string): Promise<SignInResult>;
	signUp(input: {
		name: string;
		email: string;
		password: string;
	}): Promise<SignInResult>;
	verifyTotp(code: string, trustDevice: boolean): Promise<SignInResult>;
	verifyBackupCode(code: string): Promise<SignInResult>;
	requestPasswordReset(email: string): Promise<{ error: string | null }>;
	signOut(): Promise<void>;
	listOrganizations(): Promise<Org[]>;
	setActiveOrganization(id: string): Promise<void>;
};

const toResult = (
	res: { error: { message?: string } | null; data?: unknown },
	fallback: string,
): SignInResult => {
	if (res.error)
		return { kind: "error", message: res.error.message ?? fallback };
	const data = res.data as { twoFactorRedirect?: boolean } | null | undefined;
	return data?.twoFactorRedirect
		? { kind: "two-factor" }
		: { kind: "signed-in" };
};

const httpAuth: AuthPort = {
	async getSession() {
		const { data } = await authClient.getSession();
		return data?.user ?? null;
	},
	async signInEmail({ email, password, remember }) {
		return toResult(
			await authClient.signIn.email({ email, password, rememberMe: remember }),
			"Couldn't sign you in.",
		);
	},
	async signInPasskey() {
		return toResult(
			await authClient.signIn.passkey(),
			"Passkey sign-in failed.",
		);
	},
	async signInSocial(provider) {
		return toResult(
			await authClient.signIn.social({ provider, callbackURL: "/" }),
			`Couldn't reach ${provider}.`,
		);
	},
	async signInSso(email, redirect) {
		// better-auth's redirect plugin sends the browser to the IdP on success.
		const res = await authClient.$fetch("/sign-in/sso", {
			method: "POST",
			body: {
				email,
				callbackURL: `${location.origin}${redirect}`,
				errorCallbackURL: `${location.origin}/sign-in`,
			},
		});
		return res.error
			? {
					kind: "error",
					message: res.error.message ?? "No identity provider for that email.",
				}
			: { kind: "redirecting" };
	},
	async signUp(input) {
		return toResult(
			await authClient.signUp.email(input),
			"Couldn't create the account.",
		);
	},
	async verifyTotp(code, trustDevice) {
		return toResult(
			await authClient.twoFactor.verifyTotp({ code, trustDevice }),
			"That code didn't work.",
		);
	},
	async verifyBackupCode(code) {
		return toResult(
			await authClient.twoFactor.verifyBackupCode({ code }),
			"That backup code didn't work.",
		);
	},
	async requestPasswordReset(email) {
		const res = await authClient.requestPasswordReset({
			email,
			redirectTo: "/reset-password",
		});
		return { error: res.error?.message ?? null };
	},
	async signOut() {
		await authClient.signOut();
	},
	async listOrganizations() {
		const { data } = await authClient.organization.list();
		return (data ?? []).map(({ id, name, slug }) => ({ id, name, slug }));
	},
	async setActiveOrganization(id) {
		await authClient.organization.setActive({ organizationId: id });
	},
};

// Mock identity: a signed-in owner by default so every screen is reachable in dev.
const MOCK_KEY = "ls-mock-signed-in";
const mockUser: SessionUser = {
	id: "usr_simone",
	name: "Simone Maddiona",
	email: "simone@logical.it",
};
const mockOrgs: Org[] = [
	{ id: "org_logical", name: "Logical", slug: "logical" },
	{ id: "org_acme", name: "Acme Retail", slug: "acme-retail" },
];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readMock = () => {
	try {
		return localStorage.getItem(MOCK_KEY) !== "0";
	} catch {
		return true;
	}
};
const writeMock = (signedIn: boolean) => {
	try {
		localStorage.setItem(MOCK_KEY, signedIn ? "1" : "0");
	} catch {}
	for (const l of listeners) l();
};
const listeners = new Set<() => void>();

const mockAuth: AuthPort = {
	async getSession() {
		return readMock() ? mockUser : null;
	},
	async signInEmail({ email, password }) {
		await wait(700);
		if (password.length < 8 || password === "wrong-password") {
			return { kind: "error", message: "That email and password don't match." };
		}
		if (email.startsWith("2fa")) return { kind: "two-factor" };
		writeMock(true);
		return { kind: "signed-in" };
	},
	async signInPasskey() {
		await wait(900);
		writeMock(true);
		return { kind: "signed-in" };
	},
	async signInSocial() {
		await wait(600);
		writeMock(true);
		return { kind: "signed-in" };
	},
	async signInSso(email) {
		await wait(700);
		if (!email.endsWith("@logical.it"))
			return {
				kind: "error",
				message: "No identity provider for that domain.",
			};
		writeMock(true);
		return { kind: "signed-in" };
	},
	async signUp() {
		await wait(900);
		writeMock(true);
		return { kind: "signed-in" };
	},
	async verifyTotp(code) {
		await wait(600);
		if (code === "000000")
			return {
				kind: "error",
				message: "That code has expired. Enter the current one.",
			};
		writeMock(true);
		return { kind: "signed-in" };
	},
	async verifyBackupCode(code) {
		await wait(600);
		if (!/^[a-z0-9]{5}-?[a-z0-9]{5}$/i.test(code)) {
			return { kind: "error", message: "Backup codes look like abcde-12345." };
		}
		writeMock(true);
		return { kind: "signed-in" };
	},
	async requestPasswordReset() {
		await wait(800);
		return { error: null };
	},
	async signOut() {
		await wait(200);
		writeMock(false);
	},
	async listOrganizations() {
		return mockOrgs;
	},
	async setActiveOrganization() {
		await wait(150);
	},
};

export const auth: AuthPort = isMock ? mockAuth : httpAuth;

const subscribeMock = (cb: () => void) => {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
};

function useMockSessionUser(): SessionUser | null {
	return useSyncExternalStore(subscribeMock, () =>
		readMock() ? mockUser : null,
	);
}

function useHttpSessionUser(): SessionUser | null {
	return authClient.useSession().data?.user ?? null;
}

/** Signed-in user for the shell. Real mode reads better-auth's session atom. */
export const useSessionUser = isMock ? useMockSessionUser : useHttpSessionUser;
