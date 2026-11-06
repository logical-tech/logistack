import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { Loader2, Pencil } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { BudgetMeter } from "@/components/ai/parts";
import { type BaseFeatures, DataTable } from "@/components/data-table";
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
import { Switch } from "@/components/ui/switch";
import {
	type AiBudget,
	type AiCaps,
	type AiTier,
	aiBudgetsQuery,
	formatUsd,
	useSetBudget,
} from "@/lib/api/ai";

export const Route = createFileRoute("/_app/ai/budgets")({
	staticData: { crumb: "Budgets" },
	component: Budgets,
});

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const col = createColumnHelper<BaseFeatures, AiBudget>();

function Budgets() {
	const { data } = useQuery(aiBudgetsQuery);
	const [editing, setEditing] = useState<AiBudget | null>(null);
	const withAi = data?.filter((b) => b.hasAi);
	const without = data?.filter((b) => !b.hasAi) ?? [];

	const columns = col.columns([
		col.display({
			id: "member",
			header: "Member",
			cell: ({ row: { original: b } }) => (
				<div className="min-w-0">
					<span className="block truncate font-medium">{b.name}</span>
					<span className="block truncate text-xs text-muted-foreground">
						{capitalize(b.role)}
						{b.inherited && " · default caps"}
					</span>
				</div>
			),
		}),
		col.display({
			id: "free",
			header: "Free models",
			meta: { className: "w-[26%] max-sm:hidden" },
			cell: ({ row: { original: b } }) => (
				<BudgetMeter
					tier="free"
					spent={b.spent.free}
					cap={b.caps.free}
					compact
				/>
			),
		}),
		col.display({
			id: "paid",
			header: "Paid models",
			meta: { className: "w-[26%]" },
			cell: ({ row: { original: b } }) => (
				<BudgetMeter
					tier="paid"
					spent={b.spent.paid}
					cap={b.caps.paid}
					compact
				/>
			),
		}),
		col.display({
			id: "edit",
			header: () => <span className="sr-only">Edit</span>,
			meta: { className: "w-14 text-right" },
			cell: ({ row: { original: b } }) => (
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={`Edit budget for ${b.name}`}
					onClick={() => setEditing(b)}
				>
					<Pencil />
				</Button>
			),
		}),
	]);

	return (
		<div className="grid gap-10">
			<Panel title="Monthly budgets" id="budgets">
				<p className="border-b px-4 py-3 text-sm text-pretty text-muted-foreground">
					Spend this month against each member's caps, in USD. Caps reset on the
					1st (UTC). Without a budget, admins are unlimited and everyone else
					gets $0 until you set one.
				</p>
				{!withAi ? (
					<SkeletonRows rows={4} />
				) : (
					<DataTable
						label="Monthly AI budgets"
						columns={columns}
						data={withAi}
						getRowId={(b) => b.userId}
						empty={
							<span className="text-sm text-muted-foreground">
								Nobody has AI access yet.
							</span>
						}
					/>
				)}
			</Panel>
			{without.length > 0 && (
				<Panel title="Without AI access" id="no-ai">
					<div className="grid gap-3 p-4">
						<p className="max-w-[70ch] text-sm text-pretty text-muted-foreground">
							Their role doesn't include the AI permission, so the gateway
							refuses their keys whatever the budget. Grant it with a custom
							role in{" "}
							<Link
								to="/settings/roles"
								className="text-foreground underline underline-offset-4"
							>
								Roles
							</Link>
							, then assign that role in{" "}
							<Link
								to="/settings/members"
								className="text-foreground underline underline-offset-4"
							>
								Members
							</Link>
							.
						</p>
						<ul className="flex flex-wrap gap-2">
							{without.map((b) => (
								<li
									key={b.userId}
									className="rounded-md bg-muted px-2.5 py-1 text-sm dark:bg-muted/60"
								>
									{b.name}{" "}
									<span className="text-muted-foreground">
										{capitalize(b.role)}
									</span>
								</li>
							))}
						</ul>
					</div>
				</Panel>
			)}
			<EditBudgetDialog budget={editing} onClose={() => setEditing(null)} />
		</div>
	);
}

type Draft = Record<AiTier, { unlimited: boolean; amount: string }>;

const toDraft = (caps: AiCaps): Draft => ({
	free: {
		unlimited: caps.free === null,
		amount: caps.free === null ? "" : String(caps.free),
	},
	paid: {
		unlimited: caps.paid === null,
		amount: caps.paid === null ? "" : String(caps.paid),
	},
});

function EditBudgetDialog({
	budget,
	onClose,
}: {
	budget: AiBudget | null;
	onClose: () => void;
}) {
	return (
		<Dialog open={!!budget} onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="sm:max-w-md">
				{budget && (
					<BudgetForm key={budget.userId} budget={budget} onClose={onClose} />
				)}
			</DialogContent>
		</Dialog>
	);
}

function BudgetForm({
	budget,
	onClose,
}: {
	budget: AiBudget;
	onClose: () => void;
}) {
	const save = useSetBudget();
	const [draft, setDraft] = useState<Draft>(() => toDraft(budget.caps));
	const [errors, setErrors] = useState<Partial<Record<AiTier, string>>>({});

	const submit = (e: FormEvent) => {
		e.preventDefault();
		const caps = {} as AiCaps;
		const errs: Partial<Record<AiTier, string>> = {};
		for (const tier of ["free", "paid"] as const) {
			const d = draft[tier];
			if (d.unlimited) {
				caps[tier] = null;
				continue;
			}
			const n = Number(d.amount);
			if (
				d.amount.trim() === "" ||
				!Number.isFinite(n) ||
				n < 0 ||
				n > 1_000_000
			)
				errs[tier] = "A dollar amount from 0 to 1,000,000.";
			else caps[tier] = Math.round(n * 100) / 100;
		}
		setErrors(errs);
		if (Object.keys(errs).length) return;
		save.mutate(
			{ userId: budget.userId, caps },
			{
				onSuccess: () => {
					toast.success(`Budget saved for ${budget.name}`);
					onClose();
				},
				onError: (err) =>
					toast.error("Couldn't save the budget", { description: err.message }),
			},
		);
	};

	return (
		<form onSubmit={submit} noValidate>
			<DialogHeader>
				<DialogTitle>Budget for {budget.name}</DialogTitle>
				<DialogDescription>
					Monthly caps in USD. Requests past a cap are refused until the 1st.
				</DialogDescription>
			</DialogHeader>
			<div className="my-5 grid gap-5">
				{(["free", "paid"] as const).map((tier) => {
					const d = draft[tier];
					const id = `budget-${tier}`;
					return (
						<div key={tier} className="grid gap-2">
							<div className="flex items-center justify-between gap-3">
								<span className="text-sm font-medium">
									{tier === "free" ? "Free models" : "Paid models"}
								</span>
								<label
									htmlFor={`${id}-unlimited`}
									className="flex items-center gap-2 text-sm text-muted-foreground"
								>
									Unlimited
									<Switch
										id={`${id}-unlimited`}
										aria-label={`Unlimited ${tier} models`}
										checked={d.unlimited}
										onCheckedChange={(unlimited) =>
											setDraft((x) => ({
												...x,
												[tier]: { ...x[tier], unlimited },
											}))
										}
									/>
								</label>
							</div>
							{!d.unlimited && (
								<Field
									id={id}
									label="Cap per month"
									hint={
										tier === "free"
											? `Valued at market price. Spent ${formatUsd(budget.spent.free)} this month.`
											: `Billed by the provider. Spent ${formatUsd(budget.spent.paid)} this month.`
									}
									error={errors[tier]}
								>
									<div className="relative">
										<span className="pointer-events-none absolute inset-y-0 left-3 grid place-items-center text-sm text-muted-foreground">
											$
										</span>
										<Input
											id={id}
											inputMode="decimal"
											value={d.amount}
											onChange={(e) =>
												setDraft((x) => ({
													...x,
													[tier]: { ...x[tier], amount: e.target.value },
												}))
											}
											aria-invalid={!!errors[tier] || undefined}
											aria-describedby={`${id}-msg`}
											placeholder="0"
											className="pl-6 tabular"
										/>
									</div>
								</Field>
							)}
						</div>
					);
				})}
			</div>
			<DialogFooter>
				<Button type="button" variant="ghost" onClick={onClose}>
					Cancel
				</Button>
				<Button type="submit" disabled={save.isPending}>
					{save.isPending && <Loader2 className="animate-spin" />}
					Save budget
				</Button>
			</DialogFooter>
		</form>
	);
}
