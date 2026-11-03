import type { TestResult } from "@/components/wizard/wizard";

/** What the callback page (`/sso-test`) posts to the window that opened it. */
export type SsoTestMessage = {
	type: "logistack:sso-test";
	ok: boolean;
	email?: string;
	error?: string;
	description?: string;
};

export const SSO_TEST_CALLBACK = "/sso-test";

const HINTS: Record<string, string> = {
	account_not_linked:
		"A LogiStack account with that email already exists and isn't verified. Test with an identity whose email has no account yet, or verify the existing one.",
	invalid_provider: "LogiStack doesn't know this provider. Test again.",
	signup_disabled: "New accounts are disabled on this instance.",
};

function failure(message: string, detail?: string): TestResult {
	return { ok: false, message, detail };
}

/**
 * Opens the test window right away (it must happen inside the click, or the browser blocks it),
 * then sends it to the IdP once `prepare` returns the sign-in URL, and resolves when the callback
 * page reports back or the window is closed.
 */
export function testSignIn(
	prepare: () => Promise<string>,
): Promise<TestResult> {
	const popup = window.open(
		"about:blank",
		"logistack-sso-test",
		"popup,width=520,height=720",
	);
	if (!popup)
		return Promise.resolve(
			failure(
				"The browser blocked the sign-in window",
				"Allow pop-ups for this site, then test again.",
			),
		);
	return prepare().then(
		(url) =>
			new Promise<TestResult>((resolve) => {
				const finish = (r: TestResult) => {
					window.removeEventListener("message", onMessage);
					clearInterval(watch);
					clearTimeout(timeout);
					resolve(r);
				};
				const onMessage = (e: MessageEvent<SsoTestMessage>) => {
					if (e.origin !== location.origin || e.source !== popup) return;
					if (e.data?.type !== "logistack:sso-test") return;
					const d = e.data;
					finish(
						d.ok
							? {
									ok: true,
									message: "Sign-in works",
									detail: d.email
										? `The identity provider signed in ${d.email}. This browser is now signed in as that account.`
										: undefined,
								}
							: failure(
									"The identity provider sign-in failed",
									(d.error && HINTS[d.error]) ??
										d.description ??
										d.error ??
										undefined,
								),
					);
				};
				window.addEventListener("message", onMessage);
				const watch = setInterval(() => {
					if (popup.closed)
						finish(
							failure(
								"The sign-in window was closed",
								"Finish signing in at the identity provider, then let the window close itself.",
							),
						);
				}, 500);
				const timeout = setTimeout(
					() => finish(failure("The sign-in took longer than 5 minutes")),
					300_000,
				);
				popup.location.href = url;
			}),
		(err: unknown) => {
			popup.close();
			return failure(
				"Couldn't start the sign-in",
				err instanceof Error ? err.message : String(err),
			);
		},
	);
}
