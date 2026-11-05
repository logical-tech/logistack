import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	KeyRound,
	Laptop,
	Loader2,
	Monitor,
	Plus,
	Smartphone,
	Trash2,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/access/confirm-dialog";
import { Field } from "@/components/field";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	account,
	describeAgent,
	type Passkey,
	type SessionRow,
} from "@/lib/account";
import { meQuery } from "@/lib/api/access";
import { relativeTime } from "@/lib/format";

const passkeysKey = ["account", "passkeys"];
const sessionsKey = ["account", "sessions"];

const fail = (what: string) => (err: unknown) =>
	toast.error(what, {
		description: err instanceof Error ? err.message : String(err),
	});

function Row({
	icon: Icon,
	title,
	meta,
	action,
}: {
	icon: typeof KeyRound;
	title: React.ReactNode;
	meta: React.ReactNode;
	action?: React.ReactNode;
}) {
	return (
		<li className="flex items-center gap-3 px-4 py-3">
			<span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
				<Icon className="size-4" strokeWidth={1.75} aria-hidden />
			</span>
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-2 text-sm font-medium">
					{title}
				</div>
				<p className="truncate text-xs text-muted-foreground">{meta}</p>
			</div>
			{action}
		</li>
	);
}

export function PasskeysSection() {
	const qc = useQueryClient();
	const { data, isPending } = useQuery({
		queryKey: passkeysKey,
		queryFn: () => account.listPasskeys(),
	});
	const [adding, setAdding] = useState(false);
	const [removing, setRemoving] = useState<Passkey | null>(null);
	// A passkey on its own satisfies an organization's two-factor requirement.
	const refresh = () =>
		Promise.all([
			qc.invalidateQueries({ queryKey: passkeysKey }),
			qc.invalidateQueries({ queryKey: meQuery.queryKey }),
		]);

	return (
		<Panel
			id="passkeys"
			title="Passkeys"
			actions={
				<Button variant="outline" size="sm" onClick={() => setAdding(true)}>
					<Plus data-icon="inline-start" />
					Add passkey
				</Button>
			}
		>
			{isPending ? (
				<SkeletonRows rows={2} />
			) : data?.length ? (
				<ul className="divide-y">
					{data.map((p) => (
						<Row
							key={p.id}
							icon={KeyRound}
							title={<span className="truncate">{p.name ?? "Passkey"}</span>}
							meta={[
								p.backedUp ? "Synced across devices" : "This device only",
								p.createdAt && `added ${relativeTime(p.createdAt)}`,
							]
								.filter(Boolean)
								.join(" · ")}
							action={
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={`Remove ${p.name ?? "passkey"}`}
									onClick={() => setRemoving(p)}
								>
									<Trash2 />
								</Button>
							}
						/>
					))}
				</ul>
			) : (
				<p className="px-4 py-6 text-sm text-muted-foreground">
					Sign in with Touch ID, Windows Hello or a security key instead of a
					password. Add one to get started.
				</p>
			)}
			<AddPasskeyDialog
				open={adding}
				onOpenChange={setAdding}
				onDone={refresh}
			/>
			<ConfirmDialog
				open={removing !== null}
				onOpenChange={(o) => !o && setRemoving(null)}
				title={`Remove ${removing?.name ?? "this passkey"}?`}
				description="It stops signing you in right away. The key stays in your password manager or device until you delete it there."
				confirmLabel="Remove passkey"
				onConfirm={async () => {
					if (!removing) return;
					await account.deletePasskey(removing.id).catch((e) => {
						fail("Couldn't remove the passkey")(e);
						throw e;
					});
					toast(`Removed ${removing.name ?? "passkey"}`);
					await refresh();
				}}
			/>
		</Panel>
	);
}

function AddPasskeyDialog({
	open,
	onOpenChange,
	onDone,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onDone: () => void;
}) {
	const [name, setName] = useState("");
	const [error, setError] = useState<string>();
	const add = useMutation({ mutationFn: (n: string) => account.addPasskey(n) });
	function submit(e: FormEvent) {
		e.preventDefault();
		const trimmed = name.trim();
		if (!trimmed)
			return setError("Name it after the device, like Work laptop.");
		add.mutate(trimmed, {
			onSuccess: () => {
				toast.success(`Passkey “${trimmed}” added`);
				setName("");
				onOpenChange(false);
				onDone();
			},
			onError: (err) => setError(err.message),
		});
	}
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<form onSubmit={submit} noValidate className="grid gap-5">
					<DialogHeader>
						<DialogTitle>Add a passkey</DialogTitle>
						<DialogDescription>
							Your browser asks you to confirm with Touch ID, Windows Hello,
							your phone or a security key.
						</DialogDescription>
					</DialogHeader>
					<Field id="passkey-name" label="Name" error={error}>
						<Input
							id="passkey-name"
							placeholder="Work laptop"
							value={name}
							onChange={(e) => {
								setName(e.target.value);
								setError(undefined);
							}}
							aria-invalid={error ? true : undefined}
							aria-describedby="passkey-name-msg"
							autoFocus
						/>
					</Field>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={add.isPending}>
							{add.isPending && <Loader2 className="animate-spin" />}
							Continue
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

const deviceIcon = (ua: string | null) =>
	/iPhone|Android|Mobile/.test(ua ?? "")
		? Smartphone
		: /Macintosh|Windows/.test(ua ?? "")
			? Laptop
			: Monitor;

export function SessionsSection() {
	const qc = useQueryClient();
	const { data, isPending } = useQuery({
		queryKey: sessionsKey,
		queryFn: () => account.listSessions(),
	});
	const [revoking, setRevoking] = useState<SessionRow | "others" | null>(null);
	const refresh = () => qc.invalidateQueries({ queryKey: sessionsKey });
	const others = data?.filter((s) => !s.current).length ?? 0;

	return (
		<Panel
			id="sessions"
			title="Sessions"
			actions={
				<Button
					variant="outline"
					size="sm"
					disabled={others === 0}
					onClick={() => setRevoking("others")}
				>
					Sign out other sessions
				</Button>
			}
		>
			{isPending ? (
				<SkeletonRows rows={3} />
			) : (
				<ul className="divide-y">
					{data?.map((s) => (
						<Row
							key={s.id}
							icon={deviceIcon(s.userAgent)}
							title={
								<>
									<span className="truncate">{describeAgent(s.userAgent)}</span>
									{s.current && (
										<span className="shrink-0 rounded-full bg-ok/12 px-2 py-px text-xs font-medium text-ok-text">
											This device
										</span>
									)}
								</>
							}
							meta={
								<>
									{s.ipAddress && (
										<span className="font-mono">{s.ipAddress}</span>
									)}
									{s.ipAddress && " · "}
									{s.current
										? "active now"
										: `active ${relativeTime(s.updatedAt)}`}
								</>
							}
							action={
								!s.current && (
									<Button
										variant="ghost"
										size="sm"
										onClick={() => setRevoking(s)}
									>
										Sign out
									</Button>
								)
							}
						/>
					))}
				</ul>
			)}
			<ConfirmDialog
				open={revoking !== null}
				onOpenChange={(o) => !o && setRevoking(null)}
				title={
					revoking === "others"
						? `Sign out ${others} other ${others === 1 ? "session" : "sessions"}?`
						: `Sign out ${describeAgent(revoking?.userAgent ?? null)}?`
				}
				description="Whoever uses that browser has to sign in again. This device stays signed in."
				confirmLabel="Sign out"
				onConfirm={async () => {
					try {
						if (revoking === "others") await account.revokeOtherSessions();
						else if (revoking) await account.revokeSession(revoking.token);
					} catch (e) {
						fail("Couldn't sign that session out")(e);
						throw e;
					}
					toast("Signed out");
					await refresh();
				}}
			/>
		</Panel>
	);
}
