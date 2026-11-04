import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { client } from "@/lib/api/client";
import { ok } from "@/lib/api/http";

type Row = { username: string; password: string; saved: boolean };

const authQuery = (serviceId: string) => ({
	queryKey: ["basic-auth", serviceId],
	queryFn: () =>
		ok(
			client.api.services[":id"]["basic-auth"].$get({
				param: { id: serviceId },
			}),
		),
});

/**
 * Basic auth the proxy checks before any request reaches the service: for apps that ship
 * without a login. Saving reloads the proxy; the service itself is not redeployed.
 */
export function BasicAuthPanel({ serviceId }: { serviceId: string }) {
	const qc = useQueryClient();
	const uid = useId();
	const { data } = useQuery(authQuery(serviceId));
	const [rows, setRows] = useState<Row[]>([]);
	const [enabled, setEnabled] = useState(false);
	useEffect(() => {
		if (!data) return;
		setRows(data.users.map((u) => ({ ...u, password: "", saved: true })));
		setEnabled(data.users.length > 0);
	}, [data]);
	const save = useMutation({
		mutationFn: (users: { username: string; password?: string }[]) =>
			ok(
				client.api.services[":id"]["basic-auth"].$put({
					param: { id: serviceId },
					json: { users },
				}),
			),
		onSuccess: (r) => {
			qc.setQueryData(authQuery(serviceId).queryKey, r);
			toast.success(
				r.users.length ? "Basic auth saved" : "Basic auth turned off",
				{
					description: "The proxy applies it within a few seconds.",
					icon: <KeyRound className="size-4" />,
				},
			);
		},
		onError: (e) => toast.error(e.message),
	});

	const problem = !enabled
		? null
		: rows.length === 0
			? "Add at least one user."
			: rows.some((r) => !r.username.trim())
				? "Every user needs a name."
				: rows.some((r) => !r.saved && r.password.length < 8)
					? "New users need a password of 8 or more characters."
					: rows.some((r) => r.password && r.password.length < 8)
						? "Passwords need 8 or more characters."
						: null;
	const set = (i: number, patch: Partial<Row>) =>
		setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

	return (
		<Panel
			title="Basic auth"
			id="basic-auth"
			actions={
				<Switch
					checked={enabled}
					aria-label="Require a login in front of this service"
					onCheckedChange={(on) => {
						setEnabled(on);
						if (on && rows.length === 0)
							setRows([{ username: "", password: "", saved: false }]);
					}}
				/>
			}
		>
			<form
				className="grid gap-4 px-4 py-4"
				onSubmit={(e) => {
					e.preventDefault();
					if (problem) return;
					save.mutate(
						enabled
							? rows.map((r) => ({
									username: r.username.trim(),
									...(r.password ? { password: r.password } : {}),
								}))
							: [],
					);
				}}
			>
				<p className="max-w-[65ch] text-sm text-muted-foreground">
					For apps without a login of their own. The proxy asks for a username
					and password on every domain of this service, Cloudflare Tunnel ones
					included, before the request reaches it.
				</p>
				{enabled && (
					<ul className="grid gap-2">
						{rows.map((r, i) => (
							<li
								// biome-ignore lint/suspicious/noArrayIndexKey: rows have no id until saved
								key={i}
								className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2"
							>
								<Input
									aria-label={`Username ${i + 1}`}
									id={`${uid}-u${i}`}
									value={r.username}
									onChange={(e) => set(i, { username: e.target.value })}
									placeholder="username"
									autoComplete="off"
									spellCheck={false}
									readOnly={r.saved}
									className="font-mono"
								/>
								<Input
									aria-label={`Password for user ${i + 1}`}
									type="password"
									value={r.password}
									onChange={(e) => set(i, { password: e.target.value })}
									placeholder={r.saved ? "unchanged" : "password"}
									autoComplete="new-password"
								/>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									aria-label={`Remove ${r.username || `user ${i + 1}`}`}
									onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
								>
									<Trash2 />
								</Button>
							</li>
						))}
						<li>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() =>
									setRows((rs) => [
										...rs,
										{ username: "", password: "", saved: false },
									])
								}
							>
								<Plus data-icon="inline-start" />
								Add user
							</Button>
						</li>
					</ul>
				)}
				<div className="flex items-center justify-between gap-4">
					<p className="text-sm text-bad-text" aria-live="polite">
						{problem}
					</p>
					<Button
						type="submit"
						disabled={
							Boolean(problem) ||
							save.isPending ||
							(!enabled && (data?.users.length ?? 0) === 0)
						}
					>
						{save.isPending && <Loader2 className="animate-spin" />}
						Save
					</Button>
				</div>
			</form>
		</Panel>
	);
}
