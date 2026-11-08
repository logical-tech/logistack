import { IpRange } from "@logistack/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Construction, Loader2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Field } from "@/components/field";
import { Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { client } from "@/lib/api/client";
import { ok } from "@/lib/api/http";

const maintenanceQuery = (serviceId: string) => ({
	queryKey: ["maintenance", serviceId],
	queryFn: () =>
		ok(
			client.api.services[":id"].maintenance.$get({
				param: { id: serviceId },
			}),
		),
});

/**
 * Maintenance mode: the proxy answers every domain of the service with a 503 page in the
 * organization's name, while allowlisted addresses reach the service. Nothing is redeployed.
 */
export function MaintenancePanel({ serviceId }: { serviceId: string }) {
	const qc = useQueryClient();
	const uid = useId();
	const { data } = useQuery(maintenanceQuery(serviceId));
	const [enabled, setEnabled] = useState(false);
	const [allow, setAllow] = useState("");
	const [message, setMessage] = useState("");
	useEffect(() => {
		if (!data) return;
		setEnabled(data.enabled);
		setAllow(data.allowCidrs.join("\n"));
		setMessage(data.message ?? "");
	}, [data]);
	const save = useMutation({
		mutationFn: (json: {
			enabled: boolean;
			allowCidrs: string[];
			message: string | null;
		}) =>
			ok(
				client.api.services[":id"].maintenance.$put({
					param: { id: serviceId },
					json,
				}),
			),
		onSuccess: (r) => {
			qc.setQueryData(maintenanceQuery(serviceId).queryKey, r);
			toast.success(
				r.enabled ? "Maintenance mode on" : "Maintenance mode off",
				{
					description: r.enabled
						? "Visitors see the maintenance page within a few seconds."
						: "The service is open again within a few seconds.",
					icon: <Construction className="size-4" />,
				},
			);
		},
		onError: (e) => toast.error(e.message),
	});
	const cidrs = allow.split(/[\s,]+/).filter(Boolean);
	const bad = cidrs.find((c) => !IpRange.safeParse(c).success);
	const problem = bad
		? `${bad} is not an IP address or CIDR range.`
		: message.length > 500
			? "The message is over 500 characters."
			: null;

	return (
		<Panel
			title="Maintenance mode"
			id="maintenance"
			actions={
				<Switch
					checked={enabled}
					aria-label="Show the maintenance page on every domain of this service"
					onCheckedChange={setEnabled}
				/>
			}
		>
			<form
				className="grid gap-4 px-4 py-4"
				onSubmit={(e) => {
					e.preventDefault();
					if (problem) return;
					save.mutate({
						enabled,
						allowCidrs: cidrs,
						message: message.trim() || null,
					});
				}}
			>
				<p className="max-w-[65ch] text-sm text-pretty text-muted-foreground">
					Every domain of this service answers 503 with a page carrying your
					organization's name and logo. The service keeps running, so addresses
					you allow can check it before you reopen.
				</p>
				<div className="grid gap-4 md:grid-cols-2">
					<Field
						id={`${uid}-allow`}
						label="Allowed addresses"
						optional
						hint="One per line. These reach the service as usual. Not seen through a Cloudflare Tunnel."
					>
						<Textarea
							id={`${uid}-allow`}
							value={allow}
							onChange={(e) => setAllow(e.target.value)}
							placeholder="203.0.113.7"
							className="font-mono text-sm"
							spellCheck={false}
						/>
					</Field>
					<Field
						id={`${uid}-message`}
						label="Message"
						optional
						hint="Shown on the page, such as when you expect to be back."
					>
						<Textarea
							id={`${uid}-message`}
							value={message}
							onChange={(e) => setMessage(e.target.value)}
							placeholder="Back by 14:00 UTC."
						/>
					</Field>
				</div>
				<div className="flex items-center justify-between gap-4">
					<p className="text-sm text-bad-text" aria-live="polite">
						{problem}
					</p>
					<Button type="submit" disabled={Boolean(problem) || save.isPending}>
						{save.isPending && <Loader2 className="animate-spin" />}
						Save
					</Button>
				</div>
			</form>
		</Panel>
	);
}
