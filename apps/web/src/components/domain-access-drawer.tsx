import {
	type AccessRuleInput,
	type AccessRuleView,
	BasicAuthUsername,
	IpRange,
} from "@logistack/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ArrowLeft,
	CircleAlert,
	CircleCheck,
	Fingerprint,
	KeyRound,
	Loader2,
	Network,
	Plus,
	Trash2,
} from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { ChoiceGroup } from "@/components/wizard/parts";
import { client } from "@/lib/api/client";
import { ok } from "@/lib/api/http";
import type { DomainListItem } from "@/lib/api/networking";
import { cn } from "@/lib/utils";

type Kind = AccessRuleView["type"];
type Probe = { outcome: "protected" | "open" | "error"; message: string };

/** Checked in this order by the proxy, whatever order they were added in. */
const KINDS: Record<
	Kind,
	{ title: string; description: string; icon: typeof Network }
> = {
	ip_allow: {
		title: "IP allowlist",
		description: "Only listed addresses get through. Everyone else gets 403.",
		icon: Network,
	},
	forward_auth: {
		title: "Sign-in gateway",
		description: "Authelia, Authentik or oauth2-proxy decides each request.",
		icon: Fingerprint,
	},
	basic_auth: {
		title: "Password",
		description: "The browser asks for a username and password.",
		icon: KeyRound,
	},
};
const ORDER = Object.keys(KINDS) as Kind[];

const accessQuery = (id: string) => ({
	queryKey: ["domain-access", id],
	queryFn: () => ok(client.api.domains[":id"].access.$get({ param: { id } })),
});

const lines = (text: string) =>
	text
		.split(/[\s,]+/)
		.map((s) => s.trim())
		.filter(Boolean);

type User = { username: string; password: string; saved: boolean };
type Draft = {
	kind: Kind;
	cidrs: string;
	trusted: string;
	url: string;
	headers: string;
	users: User[];
};

function draftOf(kind: Kind, rule?: AccessRuleView): Draft {
	return {
		kind,
		cidrs: rule?.type === "ip_allow" ? rule.cidrs.join("\n") : "",
		trusted:
			rule?.type === "ip_allow" ? (rule.trustedProxies ?? []).join("\n") : "",
		url: rule?.type === "forward_auth" ? rule.url : "",
		headers:
			rule?.type === "forward_auth"
				? rule.copyHeaders.join(", ")
				: "Remote-User, Remote-Groups, Remote-Email, Remote-Name",
		users:
			rule?.type === "basic_auth"
				? rule.users.map((u) => ({ ...u, password: "", saved: true }))
				: [{ username: "", password: "", saved: false }],
	};
}

/** The draft as an API rule, or the first problem to show. */
function parse(d: Draft): AccessRuleInput | string {
	if (d.kind === "ip_allow") {
		const cidrs = lines(d.cidrs);
		const trusted = lines(d.trusted);
		const bad = [...cidrs, ...trusted].find(
			(c) => !IpRange.safeParse(c).success,
		);
		if (cidrs.length === 0) return "Add at least one address or range.";
		if (bad) return `${bad} is not an IP address or CIDR range.`;
		return {
			type: "ip_allow",
			cidrs,
			...(trusted.length && { trustedProxies: trusted }),
		};
	}
	if (d.kind === "forward_auth") {
		const url = d.url.trim();
		if (!/^https?:\/\/[^/\s]+/.test(url))
			return "Enter the endpoint's full URL, starting with http:// or https://.";
		const copyHeaders = lines(d.headers);
		const bad = copyHeaders.find((h) => !/^[A-Za-z0-9-]+$/.test(h));
		if (bad) return `${bad} is not a header name.`;
		return { type: "forward_auth", url, copyHeaders };
	}
	if (d.users.length === 0) return "Add at least one user.";
	for (const u of d.users) {
		if (!BasicAuthUsername.safeParse(u.username).success)
			return "Usernames need 1 to 64 characters, without colons or spaces.";
		if (!u.saved && u.password.length < 8)
			return "New users need a password of 8 or more characters.";
		if (u.password && u.password.length < 8)
			return "Passwords need 8 or more characters.";
	}
	if (new Set(d.users.map((u) => u.username.trim())).size !== d.users.length)
		return "Usernames must be unique.";
	return {
		type: "basic_auth",
		users: d.users.map((u) => ({
			username: u.username.trim(),
			...(u.password && { password: u.password }),
		})),
	};
}

/** Saved rules sent back unchanged; basic auth users without a password keep theirs. */
const asInput = (r: AccessRuleView): AccessRuleInput =>
	r.type === "basic_auth"
		? { type: r.type, users: r.users.map((u) => ({ username: u.username })) }
		: r;

function summary(r: AccessRuleView): string {
	if (r.type === "ip_allow")
		return `${r.cidrs.join(", ")}${r.trustedProxies?.length ? ` via ${r.trustedProxies.join(", ")}` : ""}`;
	if (r.type === "forward_auth") return r.url;
	return r.users.map((u) => u.username).join(", ");
}

/**
 * Access rules for one domain, edited in a side sheet. Adding or editing a rule is a short
 * flow: pick the kind, fill it in, check it, save. Saving reloads the proxy only.
 */
export function DomainAccessDrawer({
	domain,
	onOpenChange,
}: {
	domain: DomainListItem | null;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Sheet open={domain !== null} onOpenChange={onOpenChange}>
			<SheetContent className="w-full gap-0 overflow-y-auto data-[side=right]:sm:max-w-lg">
				{domain && <Body key={domain.id} domain={domain} />}
			</SheetContent>
		</Sheet>
	);
}

function Body({ domain }: { domain: DomainListItem }) {
	const qc = useQueryClient();
	const { data, isPending } = useQuery(accessQuery(domain.id));
	const [draft, setDraft] = useState<Draft | null>(null);
	const rules = data?.rules ?? [];
	const save = useMutation({
		mutationFn: (next: AccessRuleInput[]) =>
			ok(
				client.api.domains[":id"].access.$put({
					param: { id: domain.id },
					json: { rules: next },
				}),
			),
		onSuccess: (r) => {
			qc.setQueryData(accessQuery(domain.id).queryKey, r);
			qc.invalidateQueries({ queryKey: ["domains"] });
			setDraft(null);
			toast.success(
				r.rules.length ? "Access rules saved" : "Access rules removed",
				{ description: "The proxy applies them within a few seconds." },
			);
		},
		onError: (e) => toast.error(e.message),
	});
	const replace = (rule: AccessRuleInput | null, kind: Kind) =>
		save.mutate([
			...rules.filter((r) => r.type !== kind).map(asInput),
			...(rule ? [rule] : []),
		]);

	const free = ORDER.filter(
		(k) =>
			!rules.some((r) => r.type === k) && !(k === "ip_allow" && domain.tunnel),
	);
	const blocked = domain.redirectTo
		? `This domain redirects to ${domain.redirectTo} before any check. Protect that domain instead.`
		: null;

	return (
		<>
			<SheetHeader className="border-b p-5 pr-12">
				<SheetTitle className="text-base">Access</SheetTitle>
				<SheetDescription className="font-mono text-xs">
					{domain.hostname}
					{domain.pathPrefix}
				</SheetDescription>
			</SheetHeader>
			<div className="grid gap-5 p-5">
				{blocked ? (
					<p className="text-sm text-muted-foreground">{blocked}</p>
				) : draft ? (
					<RuleFlow
						domain={domain}
						draft={draft}
						setDraft={setDraft}
						saving={save.isPending}
						onSave={(rule) => replace(rule, draft.kind)}
					/>
				) : (
					<>
						<p className="max-w-[60ch] text-sm text-pretty text-muted-foreground">
							Checks the proxy runs before a request reaches the service: the IP
							allowlist first, then the sign-in gateway, then the password. The
							service's own basic auth, if set, still applies.
						</p>
						{isPending ? (
							<div className="flex items-center gap-2 text-sm text-muted-foreground">
								<Loader2 className="size-4 animate-spin" /> Loading rules…
							</div>
						) : rules.length === 0 ? (
							<p className="rounded-lg bg-muted/60 p-4 text-sm text-muted-foreground dark:bg-muted/40">
								Anyone who knows the address can reach it.
							</p>
						) : (
							<ol className="grid gap-2">
								{ORDER.flatMap((k) => rules.filter((r) => r.type === k)).map(
									(r) => {
										const Icon = KINDS[r.type].icon;
										return (
											<li
												key={r.type}
												className="flex items-center gap-3 rounded-lg bg-card p-3 ring-1 ring-border"
											>
												<span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted">
													<Icon
														className="size-4"
														strokeWidth={1.75}
														aria-hidden
													/>
												</span>
												<div className="min-w-0 flex-1">
													<p className="text-sm font-medium">
														{KINDS[r.type].title}
													</p>
													<p className="truncate font-mono text-xs text-muted-foreground">
														{summary(r)}
													</p>
												</div>
												<Button
													variant="ghost"
													size="sm"
													onClick={() => setDraft(draftOf(r.type, r))}
												>
													Edit
												</Button>
												<Button
													variant="ghost"
													size="icon-sm"
													aria-label={`Remove ${KINDS[r.type].title}`}
													disabled={save.isPending}
													onClick={() => replace(null, r.type)}
												>
													<Trash2 />
												</Button>
											</li>
										);
									},
								)}
							</ol>
						)}
						{free[0] && (
							<div>
								<Button
									variant="outline"
									onClick={() => setDraft(draftOf(free[0] as Kind))}
								>
									<Plus data-icon="inline-start" />
									Add rule
								</Button>
							</div>
						)}
					</>
				)}
			</div>
		</>
	);
}

const STEPS = ["Kind", "Details", "Check"] as const;

function RuleFlow({
	domain,
	draft,
	setDraft,
	saving,
	onSave,
}: {
	domain: DomainListItem;
	draft: Draft;
	setDraft: (d: Draft | null) => void;
	saving: boolean;
	onSave: (rule: AccessRuleInput) => void;
}) {
	const { data } = useQuery(accessQuery(domain.id));
	const taken = new Set((data?.rules ?? []).map((r) => r.type));
	const editing = taken.has(draft.kind);
	const [step, setStep] = useState(editing ? 1 : 0);
	const [shown, setShown] = useState(false);
	const parsed = parse(draft);
	const problem = typeof parsed === "string" ? parsed : null;
	const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });

	const choices = ORDER.filter(
		(k) => !taken.has(k) && !(k === "ip_allow" && domain.tunnel),
	).map((k) => ({ value: k, ...KINDS[k] }));

	const next = () => {
		if (step === 1 && problem) return setShown(true);
		if (step === 2 && typeof parsed !== "string") return onSave(parsed);
		setStep(step + 1);
	};

	return (
		<form
			className="grid gap-5"
			onSubmit={(e) => {
				e.preventDefault();
				next();
			}}
		>
			<ol className="flex items-center gap-2 text-xs" aria-label="Steps">
				{STEPS.map((s, i) => (
					<li
						key={s}
						aria-current={i === step ? "step" : undefined}
						className={cn(
							"flex items-center gap-2",
							i === step
								? "font-medium text-foreground"
								: "text-muted-foreground",
						)}
					>
						<span
							className={cn(
								"grid size-5 place-items-center rounded-full tabular-nums ring-1",
								i === step
									? "bg-brand text-brand-foreground ring-brand"
									: i < step
										? "bg-foreground text-background ring-foreground"
										: "ring-border",
							)}
						>
							{i + 1}
						</span>
						{s}
						{i < STEPS.length - 1 && (
							<span className="h-px w-4 bg-border" aria-hidden />
						)}
					</li>
				))}
			</ol>

			<div key={step} className="t-swap grid gap-4">
				{step === 0 && (
					<ChoiceGroup
						label="Kind of rule"
						columns={1}
						value={draft.kind}
						onChange={(k) => setDraft(draftOf(k))}
						choices={choices}
						footer={
							domain.tunnel && (
								<p className="text-xs text-muted-foreground">
									No IP allowlist here: through a Cloudflare Tunnel every
									request comes from cloudflared, not the visitor.
								</p>
							)
						}
					/>
				)}
				{step === 1 && (
					<Details draft={draft} set={set} error={shown ? problem : null} />
				)}
				{step === 2 && typeof parsed !== "string" && (
					<Check domain={domain} rule={parsed} />
				)}
			</div>

			<div className="flex items-center justify-between gap-3 border-t pt-4">
				<Button
					type="button"
					variant="ghost"
					onClick={() =>
						step > (editing ? 1 : 0) ? setStep(step - 1) : setDraft(null)
					}
				>
					<ArrowLeft data-icon="inline-start" />
					{step > (editing ? 1 : 0) ? "Back" : "Cancel"}
				</Button>
				<Button type="submit" disabled={saving}>
					{saving && <Loader2 className="animate-spin" />}
					{step === 2 ? "Save rule" : "Continue"}
				</Button>
			</div>
		</form>
	);
}

function Details({
	draft,
	set,
	error,
}: {
	draft: Draft;
	set: (patch: Partial<Draft>) => void;
	error: string | null;
}) {
	const uid = useId();
	const msg = error && (
		<p className="text-sm text-bad-text" role="alert">
			{error}
		</p>
	);
	if (draft.kind === "ip_allow")
		return (
			<>
				<Field
					id={`${uid}-cidrs`}
					label="Allowed addresses"
					hint="One per line: an address such as 203.0.113.7 or a range such as 10.0.0.0/8 or 2001:db8::/32."
				>
					<Textarea
						id={`${uid}-cidrs`}
						value={draft.cidrs}
						onChange={(e) => set({ cidrs: e.target.value })}
						className="font-mono text-sm"
						spellCheck={false}
						autoFocus
					/>
				</Field>
				<Field
					id={`${uid}-trusted`}
					label="Trusted proxies"
					optional
					hint="Only if a load balancer or CDN sits in front of this server. Their X-Forwarded-For header is believed; every other request is judged by its own address."
				>
					<Textarea
						id={`${uid}-trusted`}
						value={draft.trusted}
						onChange={(e) => set({ trusted: e.target.value })}
						className="font-mono text-sm"
						spellCheck={false}
					/>
				</Field>
				{msg}
			</>
		);
	if (draft.kind === "forward_auth")
		return (
			<>
				<Field
					id={`${uid}-url`}
					label="Auth endpoint"
					hint="The proxy sends each request's headers here first. A 2xx lets it through; anything else, such as a redirect to the login page, goes back to the visitor."
				>
					<Input
						id={`${uid}-url`}
						value={draft.url}
						onChange={(e) => set({ url: e.target.value })}
						placeholder="http://authelia:9091/api/authz/forward-auth"
						className="font-mono"
						spellCheck={false}
						autoFocus
					/>
				</Field>
				<Field
					id={`${uid}-headers`}
					label="Headers passed to the service"
					optional
					hint="Copied from a 2xx answer, so the service knows who signed in. A visitor cannot forge them."
				>
					<Input
						id={`${uid}-headers`}
						value={draft.headers}
						onChange={(e) => set({ headers: e.target.value })}
						className="font-mono"
						spellCheck={false}
					/>
				</Field>
				{msg}
			</>
		);
	const setUser = (i: number, patch: Partial<User>) =>
		set({
			users: draft.users.map((u, j) => (j === i ? { ...u, ...patch } : u)),
		});
	return (
		<>
			<ul className="grid gap-2">
				{draft.users.map((u, i) => (
					<li
						// biome-ignore lint/suspicious/noArrayIndexKey: rows have no id until saved
						key={i}
						className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2"
					>
						<Input
							aria-label={`Username ${i + 1}`}
							value={u.username}
							onChange={(e) => setUser(i, { username: e.target.value })}
							placeholder="username"
							autoComplete="off"
							spellCheck={false}
							readOnly={u.saved}
							className="font-mono"
							autoFocus={i === 0}
						/>
						<Input
							aria-label={`Password for user ${i + 1}`}
							type="password"
							value={u.password}
							onChange={(e) => setUser(i, { password: e.target.value })}
							placeholder={u.saved ? "unchanged" : "password"}
							autoComplete="new-password"
						/>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							aria-label={`Remove ${u.username || `user ${i + 1}`}`}
							onClick={() =>
								set({ users: draft.users.filter((_, j) => j !== i) })
							}
						>
							<Trash2 />
						</Button>
					</li>
				))}
			</ul>
			<div>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() =>
						set({
							users: [
								...draft.users,
								{ username: "", password: "", saved: false },
							],
						})
					}
				>
					<Plus data-icon="inline-start" />
					Add user
				</Button>
			</div>
			<p className="text-xs text-muted-foreground">
				Stored as bcrypt hashes; nobody can read a password back.
			</p>
			{msg}
		</>
	);
}

function Check({
	domain,
	rule,
}: {
	domain: DomainListItem;
	rule: AccessRuleInput;
}) {
	const probe = useMutation({
		mutationFn: (url: string) =>
			ok(
				client.api.domains[":id"].access["forward-auth-test"].$post({
					param: { id: domain.id },
					json: { url },
				}),
			) as Promise<Probe>,
	});
	if (rule.type === "forward_auth") {
		const r = probe.data;
		return (
			<Panel
				state={
					probe.isPending
						? "running"
						: r
							? r.outcome === "protected"
								? "passed"
								: "failed"
							: "idle"
				}
				action={
					<Button
						type="button"
						variant={r?.outcome === "protected" ? "ghost" : "outline"}
						onClick={() => probe.mutate(rule.url)}
						disabled={probe.isPending}
					>
						{r ? "Test again" : "Send a test request"}
					</Button>
				}
			>
				{r ? (
					<p
						className={cn(
							"text-sm",
							r.outcome === "protected" ? "text-foreground" : "text-bad-text",
						)}
					>
						{r.message}
					</p>
				) : (
					<p className="text-sm text-muted-foreground">
						The server asks the endpoint about a visitor who has not signed in.
						Expect a 401, 403 or a redirect to the login page.
					</p>
				)}
			</Panel>
		);
	}
	return (
		<Panel state="passed">
			<p className="text-sm">
				{rule.type === "ip_allow"
					? `Requests from ${rule.cidrs.join(", ")} get through; any other address gets 403.`
					: `${rule.users.length === 1 ? "One user" : `${rule.users.length} users`} can sign in: ${rule.users.map((u) => u.username).join(", ")}.`}
			</p>
			{rule.type === "ip_allow" && rule.trustedProxies && (
				<p className="mt-1 text-sm text-muted-foreground">
					Behind {rule.trustedProxies.join(", ")}, the visitor's address is read
					from X-Forwarded-For.
				</p>
			)}
		</Panel>
	);
}

function Panel({
	state,
	action,
	children,
}: {
	state: "idle" | "running" | "passed" | "failed";
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div
			className="flex items-start gap-3 rounded-lg bg-muted/60 p-4 dark:bg-muted/40"
			aria-live="polite"
		>
			<span className="mt-0.5 grid size-5 shrink-0 place-items-center">
				{state === "running" && (
					<Loader2 className="size-4 animate-spin text-muted-foreground" />
				)}
				{state === "passed" && (
					<CircleCheck className="t-reveal size-5 text-ok-text" />
				)}
				{state === "failed" && (
					<CircleAlert className="t-reveal size-5 text-bad-text" />
				)}
				{state === "idle" && <span className="size-2 rounded-full bg-idle" />}
			</span>
			<div className="min-w-0 flex-1">{children}</div>
			{action}
		</div>
	);
}
