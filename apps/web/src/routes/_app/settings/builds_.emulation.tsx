import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { CircleAlert, CircleCheck, Loader2, TriangleAlert } from "lucide-react";
import { type ReactNode, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Page, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { TestPanel } from "@/components/wizard/parts";
import { Wizard, type WizardStep } from "@/components/wizard/wizard";
import {
	archOf,
	type BuildPlatforms,
	buildPlatformsQuery,
	useCheckBuildkit,
	useSetUpEmulation,
} from "@/lib/api/builds";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute("/_app/settings/builds_/emulation")({
	staticData: { crumb: "Set up emulation" },
	validateSearch: z.object({ step: stepParam }),
	component: SetUpEmulation,
});

type V = Record<string, never>;

const list = (platforms: string[]) => platforms.map(archOf).join(" and ");

function Facts({ p }: { p: BuildPlatforms | undefined }) {
	const missing = p?.missing.length ? list(p.missing) : "the missing platforms";
	const mono = (t: string) => (
		<span className="font-mono text-[13px]">{t}</span>
	);
	const rows: [string, ReactNode][] = [
		["Runs", <>{mono("tonistiigi/binfmt")}, once, as a Swarm job</>],
		["Where", "The server BuildKit runs on"],
		[
			"Access",
			<>
				{mono("CAP_SYS_ADMIN")} with the default seccomp and AppArmor profiles
				off, to mount {mono("binfmt_misc")}. Never a privileged container.
			</>,
		],
		["Registers", `QEMU for ${missing}, in that server's kernel`],
		["Then", "BuildKit restarts to pick the emulators up"],
		["Lasts", "Until that server reboots. Run this again after a reboot."],
	];
	return (
		<dl className="grid gap-x-6 gap-y-2.5 rounded-lg bg-card p-4 text-sm ring-1 ring-border sm:grid-cols-[7rem_minmax(0,1fr)]">
			{rows.map(([k, v]) => (
				<div key={k} className="contents">
					<dt className="text-muted-foreground">{k}</dt>
					<dd className="min-w-0 text-pretty">{v}</dd>
				</div>
			))}
		</dl>
	);
}

function Install({ p }: { p: BuildPlatforms | undefined }) {
	const run = useSetUpEmulation();
	const e = p?.buildkit.emulation;
	const start = () =>
		run.mutate(undefined, {
			onError: (err) =>
				toast.error("The setup didn't start", { description: err.message }),
		});
	return (
		<div
			className="rounded-lg bg-muted/60 p-4 dark:bg-muted/40"
			aria-live="polite"
		>
			<div className="flex items-start gap-3">
				<span className="mt-0.5 grid size-5 shrink-0 place-items-center">
					{e?.state === "installing" || run.isPending ? (
						<Loader2 className="size-4 animate-spin text-muted-foreground" />
					) : e?.state === "installed" ? (
						<CircleCheck className="t-reveal size-5 text-ok-text" />
					) : e?.state === "failed" ? (
						<CircleAlert className="t-reveal size-5 text-bad-text" />
					) : (
						<span className="size-2 rounded-full bg-idle" />
					)}
				</span>
				<div className="min-w-0 flex-1">
					{e?.state === "installing" ? (
						<p className="text-sm text-muted-foreground">
							Registering QEMU, then restarting BuildKit. This takes a minute or
							two.
						</p>
					) : e?.state === "installed" ? (
						<div key="installed" className="t-swap">
							<p className="text-sm font-medium">
								BuildKit builds {list(p?.buildkit.platforms?.slice(0, 1) ?? [])}{" "}
								natively and the rest through QEMU
							</p>
							<p className="mt-0.5 text-sm text-muted-foreground">
								Deploy a service again to build it for its new architectures.
							</p>
						</div>
					) : e?.state === "failed" ? (
						<div key="failed" className="t-swap">
							<p className="text-sm font-medium text-bad-text">
								The setup didn't finish
							</p>
							<p className="mt-0.5 text-sm text-pretty text-muted-foreground">
								{e.error}
							</p>
						</div>
					) : (
						<p className="text-sm text-muted-foreground">
							Nothing has run yet.
						</p>
					)}
				</div>
				{e?.state !== "installing" && e?.state !== "installed" && (
					<Button
						type="button"
						variant="outline"
						onClick={start}
						disabled={run.isPending}
					>
						{e?.state === "failed" ? "Run again" : "Run setup"}
					</Button>
				)}
			</div>
		</div>
	);
}

function SetUpEmulation() {
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: p } = useQuery(buildPlatformsQuery);
	const state = p?.buildkit.emulation?.state;
	const check = useCheckBuildkit();

	const steps = useMemo(
		(): WizardStep<V>[] => [
			{
				id: "check",
				title: "Check BuildKit",
				description:
					"BuildKit lists the platforms it can build. Emulation only adds the ones it lacks.",
				test: async () => {
					const now = await check.mutateAsync();
					if (now.buildkit.error)
						return {
							ok: false,
							message: "BuildKit didn't answer",
							detail: now.buildkit.error,
						};
					if (!now.missing.length)
						return {
							ok: false,
							message: "Nothing to set up",
							detail: `BuildKit already builds ${list(["linux/amd64", "linux/arm64"])}.`,
						};
					return {
						ok: true,
						message: `BuildKit can't build ${list(now.missing)} yet`,
						detail: `It runs on ${archOf(now.buildkit.platforms?.[0] ?? "an unknown platform")}. QEMU adds ${list(now.missing)}.`,
					};
				},
				render: (w) => (
					<TestPanel
						w={w}
						action="Check BuildKit"
						idle="We'll ask BuildKit for its platforms. Nothing changes on the server."
					/>
				),
			},
			{
				id: "review",
				title: "Review what runs",
				description:
					"One short job on BuildKit's server. Read what it touches before you run it.",
				render: () => (
					<div className="grid gap-4">
						<Facts p={p} />
						<div className="flex items-start gap-3 rounded-lg bg-warn/10 px-3.5 py-3 text-sm">
							<TriangleAlert
								className="mt-0.5 size-4 shrink-0 text-warn-text"
								aria-hidden
							/>
							<p className="max-w-[68ch] text-pretty">
								<span className="font-medium">
									Builds running when BuildKit restarts fail.
								</span>{" "}
								<span className="text-muted-foreground">
									Pick a quiet moment, or deploy them again afterwards.
								</span>
							</p>
						</div>
					</div>
				),
			},
			{
				id: "run",
				title: "Set up emulation",
				description:
					"The worker runs the job, restarts BuildKit and checks it again.",
				ready: () =>
					state === "installed" ? true : "Run the setup to continue",
				render: () => <Install p={p} />,
			},
		],
		[p, state, check.mutateAsync],
	);

	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: { step: id }, replace }),
		[navigate],
	);

	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="Set up cross-architecture builds"
				description="QEMU lets BuildKit build for servers whose processor differs from its own, so one deploy serves both amd64 and arm64 servers."
			/>
			<Wizard
				id="build-emulation"
				steps={steps}
				defaultValues={{}}
				step={step}
				onStepChange={onStepChange}
				finishLabel="Done"
				onComplete={async () => {
					toast.success("Cross-architecture builds are on");
					await navigate({ to: "/settings/builds" });
				}}
			/>
		</Page>
	);
}
