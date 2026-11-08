import { Loader2, TriangleAlert } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import {
	ACTION_LABELS,
	PERMISSION_ACTIONS,
	useCreateRole,
	useRemoveRole,
	useUpdateRole,
} from "@/lib/api/access";
import type { PermissionAction, Role } from "@/lib/api/access-types";
import { cn } from "@/lib/utils";

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const RESERVED = ["owner", "admin", "developer", "viewer", "member"];

/** Which custom role the sheet works on; null keeps it closed. */
export type EditorState = { mode: "create" } | { mode: "edit"; role: Role };

export function RoleEditor({
	state,
	onOpenChange,
}: {
	state: EditorState | null;
	onOpenChange: (open: boolean) => void;
}) {
	const editing = state?.mode === "edit" ? state.role : null;
	const [name, setName] = useState("");
	const [actions, setActions] = useState<PermissionAction[]>([]);
	const [errors, setErrors] = useState<{ name?: string; actions?: string }>({});
	const create = useCreateRole();
	const update = useUpdateRole();
	const remove = useRemoveRole();
	const pending = create.isPending || update.isPending;

	useEffect(() => {
		if (!state) return;
		setErrors({});
		setName(editing?.name ?? "");
		setActions(
			editing ? (editing.actions as PermissionAction[]) : ["read", "deploy"],
		);
	}, [state, editing]);

	function toggle(a: PermissionAction, on: boolean) {
		setActions((cur) =>
			on
				? PERMISSION_ACTIONS.filter((x) => x === a || cur.includes(x))
				: cur.filter((x) => x !== a),
		);
		setErrors((e) => ({ ...e, actions: undefined }));
	}

	function submit(e: FormEvent) {
		e.preventDefault();
		const next: typeof errors = {};
		if (!editing) {
			if (!NAME.test(name))
				next.name =
					"Lowercase letters, digits and dashes, starting with a letter.";
			else if (RESERVED.includes(name))
				next.name = "That name belongs to a built-in role.";
		}
		if (actions.length === 0) next.actions = "Pick at least one action.";
		if (next.name || next.actions) return setErrors(next);
		const done = () => onOpenChange(false);
		const fail = (err: Error) =>
			editing
				? toast.error("Couldn't save the role", { description: err.message })
				: setErrors({ name: err.message });
		if (editing)
			update.mutate(
				{ name: editing.name, actions },
				{
					onSuccess: () => {
						toast.success(`Role ${editing.name} updated`, {
							description:
								editing.usage > 0
									? `Applies now to ${editing.usage} holder${editing.usage === 1 ? "" : "s"}.`
									: undefined,
						});
						done();
					},
					onError: fail,
				},
			);
		else
			create.mutate(
				{ name, actions },
				{
					onSuccess: () => {
						toast.success(`Role ${name} created`);
						done();
					},
					onError: fail,
				},
			);
	}

	function destroy() {
		if (!editing) return;
		remove.mutate(editing.name, {
			onSuccess: () => {
				toast.success(`Role ${editing.name} deleted`);
				onOpenChange(false);
			},
			onError: (err) =>
				toast.error("Couldn't delete the role", { description: err.message }),
		});
	}

	return (
		<Sheet open={state !== null} onOpenChange={onOpenChange}>
			<SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md">
				<form
					onSubmit={submit}
					noValidate
					className="flex min-h-0 flex-1 flex-col"
				>
					<SheetHeader className="px-6 pt-6 pb-2">
						<SheetTitle className="text-md">
							{editing ? `Edit ${editing.name}` : "New custom role"}
						</SheetTitle>
						<SheetDescription>
							{editing
								? "Changes apply at once to everyone holding this role, on every scope it was granted."
								: "Grant it to a member on the organization or on one folder, project, environment or service."}
						</SheetDescription>
					</SheetHeader>

					<div className="grid flex-1 content-start gap-6 overflow-y-auto px-6 py-4">
						<Field
							id="role-name"
							label="Name"
							error={errors.name}
							hint={
								editing
									? "Names can't change once created."
									: "Like deployer or release-manager."
							}
						>
							<Input
								id="role-name"
								value={name}
								disabled={Boolean(editing)}
								onChange={(e) => {
									setName(e.target.value);
									setErrors((x) => ({ ...x, name: undefined }));
								}}
								autoComplete="off"
								spellCheck={false}
								placeholder="deployer"
								aria-invalid={errors.name ? true : undefined}
								aria-describedby="role-name-msg"
								className="font-mono"
							/>
						</Field>

						<fieldset className="grid gap-2">
							<legend className="mb-2 text-sm font-medium">
								Allowed actions
							</legend>
							<ul className="grid gap-1">
								{PERMISSION_ACTIONS.map((a) => {
									const id = `role-action-${a.replace(":", "-")}`;
									const sensitive =
										a === "read:secrets" ||
										a === "admin" ||
										a === "exec" ||
										a === "plugins";
									const on = actions.includes(a);
									return (
										<li key={a}>
											<label
												htmlFor={id}
												className={cn(
													"flex cursor-pointer gap-3 rounded-lg px-3 py-2.5 transition-colors duration-(--duration-quick) hover:bg-muted/60",
													on && "bg-muted/60",
												)}
											>
												<Checkbox
													id={id}
													checked={on}
													onCheckedChange={(v) => toggle(a, v === true)}
													className="mt-0.5"
												/>
												<span className="grid gap-0.5">
													<span className="flex items-center gap-2 text-sm font-medium">
														{ACTION_LABELS[a].label}
														{sensitive && (
															<span className="inline-flex items-center gap-1 text-xs font-normal text-warn-text">
																<TriangleAlert className="size-3" aria-hidden />
																Sensitive
															</span>
														)}
													</span>
													<span className="text-xs text-pretty text-muted-foreground">
														{ACTION_LABELS[a].description}
													</span>
												</span>
											</label>
										</li>
									);
								})}
							</ul>
							<p
								className={cn(
									"text-xs",
									errors.actions ? "text-bad-text" : "sr-only",
								)}
								aria-live="polite"
							>
								{errors.actions}
							</p>
						</fieldset>

						{editing && (
							<div className="grid gap-2 rounded-lg bg-muted/60 px-3 py-3">
								<p className="text-sm font-medium">Delete role</p>
								<p className="text-xs text-pretty text-muted-foreground">
									{editing.usage > 0
										? `Held by ${editing.usage} member${editing.usage === 1 ? "" : "s"} or grant${editing.usage === 1 ? "" : "s"}. Change or remove those first, then delete it.`
										: "Nobody holds this role. Deleting it can't be undone."}
								</p>
								<Button
									type="button"
									variant="destructive"
									size="sm"
									className="justify-self-start"
									disabled={editing.usage > 0 || remove.isPending}
									onClick={destroy}
								>
									{remove.isPending && <Loader2 className="animate-spin" />}
									Delete role
								</Button>
							</div>
						)}
					</div>

					<SheetFooter className="flex-row justify-end gap-2 px-6 py-4 shadow-[0_-1px_0_var(--border)]">
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={pending}>
							{pending && <Loader2 className="animate-spin" />}
							{editing ? "Save changes" : "Create role"}
						</Button>
					</SheetFooter>
				</form>
			</SheetContent>
		</Sheet>
	);
}
