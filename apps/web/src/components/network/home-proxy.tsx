import {
	formatHomeProxyUpstream,
	type HomeProxyRoute,
	HomeProxyRouteInput,
	type HomeProxyTestResult,
	parseHomeProxyUpstream,
} from "@logistack/contracts";
import { useMutation } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, Loader2 } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { Field } from "@/components/field";
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
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
	InputGroupText,
} from "@/components/ui/input-group";
import { Switch } from "@/components/ui/switch";
import { type HomeProxyRouteDraft, homeProxyApi } from "@/lib/api/home-proxy";

export const TLS_LABEL = {
	acme: "Let's Encrypt wildcard",
	internal: "Internal certificate authority",
} as const;

/** The API's messages are lowercase fragments; the form shows them as sentences. */
const sentence = (m: string) =>
	`${m.charAt(0).toUpperCase()}${m.slice(1)}${/[.?!]$/.test(m) ? "" : "."}`;

/** Saves Caddy's internal root as a file devices can import. */
export function downloadCaRoot(pem: string) {
	const url = URL.createObjectURL(
		new Blob([pem], { type: "application/x-x509-ca-cert" }),
	);
	const a = document.createElement("a");
	a.href = url;
	a.download = "logistack-local-ca.crt";
	a.click();
	URL.revokeObjectURL(url);
}

/** Adds or edits one route; validated with the API's own schema, tested before saving. */
export function RouteDialog({
	open,
	onOpenChange,
	zone,
	route,
	onSave,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	zone: string;
	route: HomeProxyRoute | null;
	onSave: (r: HomeProxyRouteDraft) => Promise<unknown>;
}) {
	const uid = useId();
	const [name, setName] = useState("");
	const [upstream, setUpstream] = useState("");
	const [insecure, setInsecure] = useState(false);
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const test = useMutation({
		mutationFn: (v: { upstream: string; insecure: boolean }) =>
			homeProxyApi.test(v.upstream, v.insecure),
	});
	const { reset } = test;

	useEffect(() => {
		if (!open) return;
		setName(route?.name ?? "");
		setUpstream(route?.upstream ?? "");
		setInsecure(route?.insecure ?? false);
		setErrors({});
		reset();
	}, [open, route, reset]);

	const parsed = parseHomeProxyUpstream(upstream);
	const https = parsed?.scheme === "https";
	const label = name.trim().toLowerCase() || "name";

	const edit = (fn: () => void) => {
		fn();
		setErrors({});
		reset();
	};

	const validate = () => {
		const r = HomeProxyRouteInput.safeParse({
			name,
			upstream,
			insecure: https && insecure,
		});
		if (r.success) return r.data;
		setErrors(
			Object.fromEntries(
				r.error.issues.map((i) => [String(i.path[0]), sentence(i.message)]),
			),
		);
		return null;
	};

	const runTest = () => {
		const r = HomeProxyRouteInput.shape.upstream.safeParse(upstream);
		if (!r.success) {
			setErrors({
				upstream: sentence(r.error.issues[0]?.message ?? "invalid address"),
			});
			return;
		}
		test.mutate({ upstream: r.data, insecure: https && insecure });
	};

	async function submit(e: FormEvent) {
		e.preventDefault();
		const data = validate();
		if (!data) return;
		setBusy(true);
		try {
			await onSave(data);
			onOpenChange(false);
		} catch (err) {
			setErrors({
				form: sentence(err instanceof Error ? err.message : String(err)),
			});
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
			<DialogContent className="sm:max-w-lg">
				<form onSubmit={submit} noValidate className="grid gap-5">
					<DialogHeader>
						<DialogTitle>{route ? "Edit route" : "Add route"}</DialogTitle>
						<DialogDescription>
							An HTTPS name for a device on your network. It answers only to
							private addresses.
						</DialogDescription>
					</DialogHeader>

					<Field
						id={`${uid}-name`}
						label="Name"
						error={errors.name}
						hint={
							<>
								Opens at{" "}
								<span className="font-mono text-foreground">
									https://{label}.{zone}
								</span>
							</>
						}
					>
						<InputGroup>
							<InputGroupInput
								id={`${uid}-name`}
								value={name}
								onChange={(e) => edit(() => setName(e.target.value))}
								placeholder="nas"
								autoFocus
								autoCapitalize="none"
								autoComplete="off"
								spellCheck={false}
								className="font-mono"
								aria-invalid={errors.name ? true : undefined}
								aria-describedby={`${uid}-name-msg`}
							/>
							<InputGroupAddon align="inline-end">
								<InputGroupText className="max-w-48 truncate font-mono font-normal">
									.{zone}
								</InputGroupText>
							</InputGroupAddon>
						</InputGroup>
					</Field>

					<Field
						id={`${uid}-upstream`}
						label="Device address"
						error={errors.upstream}
						hint={
							parsed ? (
								<>
									Proxies to{" "}
									<span className="font-mono text-foreground">
										{formatHomeProxyUpstream(parsed)}
									</span>
								</>
							) : (
								"An address and port, or a URL pasted from the browser."
							)
						}
					>
						<Input
							id={`${uid}-upstream`}
							value={upstream}
							onChange={(e) => edit(() => setUpstream(e.target.value))}
							placeholder="192.168.1.10:8080"
							autoCapitalize="none"
							autoComplete="off"
							spellCheck={false}
							inputMode="url"
							className="font-mono"
							aria-invalid={errors.upstream ? true : undefined}
							aria-describedby={`${uid}-upstream-msg`}
						/>
					</Field>

					{https && (
						<div className="t-reveal flex items-start justify-between gap-6">
							<label
								htmlFor={`${uid}-insecure`}
								className="grid gap-0.5 text-sm"
							>
								<span className="font-medium">Ignore certificate errors</span>
								<span className="text-pretty text-muted-foreground">
									For devices with a self-signed certificate, like most NAS,
									Proxmox and UniFi consoles.
								</span>
							</label>
							<Switch
								id={`${uid}-insecure`}
								checked={insecure}
								onCheckedChange={(c) => edit(() => setInsecure(c))}
							/>
						</div>
					)}

					<TestRow
						pending={test.isPending}
						result={test.data}
						error={test.error?.message}
						tlsHint={
							https &&
							!insecure &&
							/certificate|tls|ssl/i.test(test.data?.error ?? "")
						}
						disabled={!upstream.trim()}
						onRun={runTest}
					/>

					{errors.form && (
						<p className="text-sm text-bad-text" role="alert">
							{errors.form}
						</p>
					)}

					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
							disabled={busy}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={busy}>
							{busy && <Loader2 className="animate-spin" />}
							{route ? "Save route" : "Add route"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function TestRow({
	pending,
	result,
	error,
	tlsHint,
	disabled,
	onRun,
}: {
	pending: boolean;
	result: HomeProxyTestResult | undefined;
	error: string | undefined;
	/** The test ran against HTTPS with verification on, so a certificate failure is likely. */
	tlsHint: boolean;
	disabled: boolean;
	onRun: () => void;
}) {
	const failed = error ?? (result && !result.ok ? result.error : null);
	const passed = result?.ok && !pending;
	return (
		<div
			className="flex items-start gap-3 rounded-lg bg-muted/60 p-3 dark:bg-muted/40"
			aria-live="polite"
		>
			<span className="mt-0.5 grid size-5 shrink-0 place-items-center">
				{pending ? (
					<Loader2 className="size-4 animate-spin text-muted-foreground" />
				) : passed ? (
					<CircleCheck className="t-reveal size-5 text-ok-text" />
				) : failed ? (
					<CircleAlert className="t-reveal size-5 text-bad-text" />
				) : (
					<span className="size-2 rounded-full bg-idle" />
				)}
			</span>
			<div className="min-w-0 flex-1 text-sm">
				{pending ? (
					<p className="text-muted-foreground">Connecting from the server…</p>
				) : passed && result ? (
					<p key="ok" className="t-swap">
						<span className="font-medium">Reachable</span>
						<span className="text-muted-foreground tabular">
							{" "}
							· HTTP {result.status} in {result.ms} ms
						</span>
					</p>
				) : failed ? (
					<div key={failed} className="t-swap">
						<p className="font-medium text-bad-text">Not reachable</p>
						<p className="mt-0.5 break-words text-muted-foreground">
							{sentence(failed)}
							{tlsHint &&
								" If the device uses a self-signed certificate, turn on Ignore certificate errors."}
						</p>
					</div>
				) : (
					<p className="text-muted-foreground">
						Check that the server can reach the device before saving.
					</p>
				)}
			</div>
			<Button
				type="button"
				size="sm"
				variant={passed ? "ghost" : "outline"}
				onClick={onRun}
				disabled={pending || disabled}
				className="shrink-0"
			>
				{result || error ? "Test again" : "Test connection"}
			</Button>
		</div>
	);
}
