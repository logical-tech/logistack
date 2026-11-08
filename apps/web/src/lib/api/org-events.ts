import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { subscribeEvents } from "./live";
import { useActiveOrgId } from "./monitoring";

/** Views built from deployments, service states and nodes: every org event can change them. */
const REFRESHED = [["overview"], ["network-map"]];

/**
 * Refetches the overview and the network map when an `org:<id>` event arrives on /ws, instead of
 * polling them. Bursts (a deploy emits several events) coalesce into one refetch.
 */
export function useOrgEventRefresh() {
	const qc = useQueryClient();
	const orgId = useActiveOrgId();
	useEffect(() => {
		if (!orgId) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const off = subscribeEvents(`org:${orgId}`, () => {
			clearTimeout(timer);
			timer = setTimeout(() => {
				for (const queryKey of REFRESHED)
					void qc.invalidateQueries({ queryKey });
			}, 300);
		});
		return () => {
			clearTimeout(timer);
			off();
		};
	}, [orgId, qc]);
}
