import { useQuery } from "@tanstack/react-query";
import {
	CircleAlert,
	CircleCheck,
	KeyRound,
	Loader2,
	TriangleAlert,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/copy-button";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { sshKeysQuery, useCreateSshKey } from "@/lib/api/access";
import type { PreflightCheck } from "@/lib/api/types";
import { cn } from "@/lib/utils";

const NEW = "__new";

/** Picks an existing key or generates one inline, then shows how to authorize it. */
export function SshKeyField({
	value,
	onChange,
	sshUser,
	error,
}: {
	value: string;
	onChange: (id: string) => void;
	sshUser: string;
	error?: string;
}) {
	const { data: keys } = useQuery(sshKeysQuery);
	const generate = useCreateSshKey();
	const [creating, setCreating] = useState(false);
	const [name, setName] = useState("LogiStack cluster");
	const selected = keys?.find((k) => k.id === value);
	const showForm = creating || keys?.length === 0;
	const only = keys?.length === 1 ? keys[0]?.id : undefined;

	// One key on file is the answer nine times in ten; preselect it.
	useEffect(() => {
		if (!value && only) onChange(only);
	}, [value, only, onChange]);

	const authorize = selected
		? `mkdir -p ~/.ssh && echo '${selected.publicKey}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`
		: "";

	return (
		<div className="grid gap-3">
			<Field
				id="wz-sshKeyId"
				label="SSH key"
				error={error}
				hint="LogiStack keeps the private half encrypted on this server; it never leaves it."
			>
				{keys === undefined ? (
					<span className="t-skel h-9 rounded-lg bg-muted-foreground/12" />
				) : keys.length > 0 ? (
					<Select
						value={creating ? NEW : value || undefined}
						onValueChange={(v) => {
							if (v === NEW) return setCreating(true);
							setCreating(false);
							onChange(v);
						}}
					>
						<SelectTrigger
							id="wz-sshKeyId"
							className="w-full"
							aria-invalid={error ? true : undefined}
							aria-describedby="wz-sshKeyId-msg"
						>
							<SelectValue placeholder="Choose a key" />
						</SelectTrigger>
						<SelectContent>
							{keys.map((k) => (
								<SelectItem key={k.id} value={k.id}>
									<KeyRound className="text-muted-foreground" />
									{k.name}
									<span className="font-mono text-2xs text-muted-foreground">
										{k.fingerprint.slice(0, 19)}…
									</span>
								</SelectItem>
							))}
							<SelectSeparator />
							<SelectItem value={NEW}>Generate a new key</SelectItem>
						</SelectContent>
					</Select>
				) : null}
			</Field>

			{showForm && (
				<div className="t-reveal grid gap-2 rounded-lg bg-muted/60 p-3 dark:bg-muted/40">
					<label htmlFor="new-key-name" className="text-sm font-medium">
						New ed25519 key
					</label>
					<div className="flex gap-2">
						<Input
							id="new-key-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") e.preventDefault();
							}}
							aria-label="Key name"
						/>
						<Button
							type="button"
							variant="outline"
							disabled={!name.trim() || generate.isPending}
							onClick={() =>
								generate.mutate(
									{ name: name.trim() },
									{
										onSuccess: (k) => {
											onChange(k.id);
											setCreating(false);
											toast.success(`Generated ${k.name}`);
										},
										onError: (e) =>
											toast.error("Couldn't generate the key", {
												description: e instanceof Error ? e.message : String(e),
											}),
									},
								)
							}
						>
							{generate.isPending && <Loader2 className="animate-spin" />}
							Generate
						</Button>
					</div>
				</div>
			)}

			{selected && !creating && (
				<div className="t-reveal grid gap-3 rounded-lg bg-muted/60 p-3 dark:bg-muted/40">
					<div className="grid gap-1.5">
						<div className="flex items-center justify-between gap-2">
							<span className="text-xs font-medium">Public key</span>
							<CopyButton value={selected.publicKey} label="Copy public key" />
						</div>
						<code className="block font-mono text-xs break-all text-muted-foreground select-all">
							{selected.publicKey}
						</code>
					</div>
					<div className="grid gap-1.5">
						<div className="flex items-center justify-between gap-2">
							<span className="text-xs font-medium">
								On the server, as {sshUser || "the SSH user"}, run
							</span>
							<CopyButton value={authorize} label="Copy command" />
						</div>
						<code className="block rounded-md bg-card px-2.5 py-2 font-mono text-xs break-all ring-1 ring-border select-all">
							{authorize}
						</code>
					</div>
				</div>
			)}
		</div>
	);
}

const CHECK_ICON = {
	ok: { icon: CircleCheck, className: "text-ok-text", label: "Passed" },
	warn: { icon: TriangleAlert, className: "text-warn-text", label: "Warning" },
	fail: { icon: CircleAlert, className: "text-bad-text", label: "Failed" },
} as const;

export function PreflightList({ checks }: { checks: PreflightCheck[] }) {
	if (!checks.length) return null;
	return (
		<ul className="divide-y rounded-lg bg-card ring-1 ring-border">
			{checks.map((c) => {
				const meta = CHECK_ICON[c.status];
				return (
					<li
						key={c.id}
						className="t-reveal flex items-start gap-3 px-3.5 py-2.5"
					>
						<meta.icon
							className={cn("mt-0.5 size-4 shrink-0", meta.className)}
							strokeWidth={1.75}
							aria-label={meta.label}
						/>
						<div className="min-w-0">
							<p className="text-sm font-medium">{c.label}</p>
							<p className="text-xs text-muted-foreground">{c.detail}</p>
						</div>
					</li>
				);
			})}
		</ul>
	);
}

/** The bootstrap transcript; follows the newest line unless the reader scrolled up. */
export function JoinLog({
	lines,
	running,
}: {
	lines: string[];
	running: boolean;
}) {
	const ref = useRef<HTMLPreElement>(null);
	const pinned = useRef(true);
	useEffect(() => {
		const el = ref.current;
		if (el && pinned.current && lines.length) el.scrollTop = el.scrollHeight;
	}, [lines.length]);
	return (
		<pre
			ref={ref}
			role="log"
			onScroll={(e) => {
				const el = e.currentTarget;
				pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
			}}
			aria-label="Bootstrap log"
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling log must be reachable by keyboard
			tabIndex={0}
			className="h-64 overflow-auto rounded-lg bg-[oklch(0.17_0.005_262)] p-3.5 font-mono text-xs leading-5 text-[oklch(0.9_0.005_262)] outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-[oklch(0.13_0.004_262)] dark:ring-1 dark:ring-border"
		>
			{lines.length === 0 ? (
				<span className="text-[oklch(0.65_0.01_262)]">
					The log streams here once the bootstrap starts.
				</span>
			) : (
				lines.map((l, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: append-only log lines
					<span key={i} className="block">
						<span className="mr-3 text-[oklch(0.55_0.01_262)] select-none">
							{String(i + 1).padStart(2, " ")}
						</span>
						{l}
					</span>
				))
			)}
			{running && (
				<span className="mt-1 block animate-pulse text-[oklch(0.65_0.01_262)]">
					…
				</span>
			)}
		</pre>
	);
}
