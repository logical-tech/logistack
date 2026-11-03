import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { AuthHeading } from "@/components/auth-parts";
import { auth } from "@/lib/auth";
import type { SsoTestMessage } from "@/lib/sso-test";

/** Where the wizard's test sign-in lands: reports the outcome to the opener, then closes. */
export const Route = createFileRoute("/_auth/sso-test")({
	validateSearch: z.object({
		error: z.string().optional(),
		error_description: z.string().optional(),
	}),
	component: SsoTestCallback,
});

function SsoTestCallback() {
	const { error, error_description } = Route.useSearch();
	const [orphan, setOrphan] = useState(false);

	useEffect(() => {
		const opener = window.opener as Window | null;
		if (!opener) {
			setOrphan(true);
			return;
		}
		const send = (m: Omit<SsoTestMessage, "type">) => {
			opener.postMessage({ type: "logistack:sso-test", ...m }, location.origin);
			window.close();
		};
		if (error) send({ ok: false, error, description: error_description });
		else
			auth.getSession().then(
				(u) =>
					u
						? send({ ok: true, email: u.email })
						: send({ ok: false, error: "no_session" }),
				() => send({ ok: false, error: "no_session" }),
			);
	}, [error, error_description]);

	return (
		<AuthHeading title={error ? "Sign-in failed" : "Finishing the test"}>
			{orphan
				? "This window reports a test sign-in back to LogiStack. You can close it."
				: "This window closes on its own."}
		</AuthHeading>
	);
}
