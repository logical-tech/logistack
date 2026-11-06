"use client";

import { useEffect, useState } from "react";
import { sponsorsApi, sponsorsSandboxApi } from "@/content/sponsor";
import { CopyCommand } from "./copy-command";

type State =
	| { kind: "none" }
	| { kind: "loading" }
	| { kind: "ready"; key: string; instance: string | null }
	| { kind: "late" };

/**
 * Stripe redirects here with `?session_id=cs_…`. The webhook that issues the key can land a
 * moment after the redirect, so the page asks a few times before falling back to the email.
 */
export function SponsorKey() {
	const [state, setState] = useState<State>({ kind: "loading" });

	useEffect(() => {
		const params = new URLSearchParams(location.search);
		const id = params.get("session_id");
		const api =
			params.get("sandbox") === "1" ? sponsorsSandboxApi : sponsorsApi;
		if (!id?.startsWith("cs_")) {
			setState({ kind: "none" });
			return;
		}
		let stopped = false;
		(async () => {
			for (let i = 0; i < 10 && !stopped; i++) {
				try {
					const res = await fetch(`${api}/v1/sessions/${id}`);
					if (res.ok) {
						const { key, instance } = (await res.json()) as {
							key: string;
							instance?: string | null;
						};
						if (!stopped)
							setState({ kind: "ready", key, instance: instance ?? null });
						return;
					}
				} catch {}
				await new Promise((r) => setTimeout(r, 1500));
			}
			if (!stopped) setState({ kind: "late" });
		})();
		return () => {
			stopped = true;
		};
	}, []);

	if (state.kind === "none") return null;
	return (
		<div className="flex max-w-[720px] flex-col gap-3 pt-2" aria-live="polite">
			<h2 className="text-lg font-medium">Your sponsor key</h2>
			{state.kind === "ready" ? (
				<>
					<CopyCommand command={state.key} />
					{state.instance && (
						<a
							// The key rides in the fragment, which never reaches a server.
							href={`${state.instance}/settings/sponsor#key=${state.key}`}
							className="pressable inline-flex h-12 w-fit items-center rounded-full bg-fg px-[22px] text-[15px] font-semibold text-bg hover:bg-white"
						>
							Activate on {new URL(state.instance).host}
						</a>
					)}
					<p className="max-w-[60ch] text-[15px] leading-relaxed text-pretty text-muted">
						In LogiStack, open Settings, then Sponsor, and paste it. We also
						emailed it to you. A monthly key renews itself while the sponsorship
						is active.
					</p>
				</>
			) : state.kind === "loading" ? (
				<p className="text-[15px] text-muted">Preparing your key…</p>
			) : (
				<p className="max-w-[60ch] text-[15px] leading-relaxed text-pretty text-muted">
					Your key is on its way by email. It can take a minute. Paste it in
					LogiStack under Settings, then Sponsor.
				</p>
			)}
		</div>
	);
}
