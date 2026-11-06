import { type ResourceProfile, ResourceProfiles } from "@logistack/contracts";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { isOrgAdmin } from "@/components/access/members-dialogs";
import { Field } from "@/components/field";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	useMe,
	useResourceProfiles,
	useSetResourceProfiles,
} from "@/lib/api/access";

const NONE = "__none";
const num = (v: string) => (v === "" ? undefined : Number(v));

/** Named CPU and memory sizes services pick from, and the default new services get. */
export function ResourceProfilesPanel() {
	const { data: saved, isPending } = useResourceProfiles();
	const { data: me } = useMe();
	const save = useSetResourceProfiles();
	const canEdit = isOrgAdmin(me);
	const [draft, setDraft] = useState<ResourceProfiles>();

	useEffect(() => {
		if (saved) setDraft(saved);
	}, [saved]);

	if (isPending || !saved || !draft)
		return (
			<Panel id="resource-profiles" title="Resource profiles">
				<SkeletonRows rows={3} />
			</Panel>
		);

	const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
	const parsed = ResourceProfiles.safeParse(draft);
	const first = parsed.success ? undefined : parsed.error.issues[0];
	const issue =
		first?.path.at(-1) === "cpu" || first?.path.at(-1) === "memoryMb"
			? "CPU and memory are above zero, memory in whole megabytes. Leave one empty for no limit."
			: first?.message;

	const setProfile = (i: number, patch: Partial<ResourceProfile>) =>
		setDraft((d) => {
			if (!d) return d;
			const before = d.profiles[i]?.name;
			return {
				profiles: d.profiles.map((p, j) => (j === i ? { ...p, ...patch } : p)),
				// Renaming the default keeps it the default.
				defaultProfile:
					patch.name !== undefined && d.defaultProfile === before
						? patch.name
						: d.defaultProfile,
			};
		});
	const remove = (i: number) =>
		setDraft((d) =>
			d
				? {
						profiles: d.profiles.filter((_, j) => j !== i),
						defaultProfile:
							d.defaultProfile === d.profiles[i]?.name
								? null
								: d.defaultProfile,
					}
				: d,
		);

	const submit = () => {
		if (!parsed.success) return;
		save.mutate(parsed.data, {
			onSuccess: () => toast("Resource profiles saved"),
			onError: (err) =>
				toast.error("Couldn't save the profiles", {
					description: err.message,
				}),
		});
	};

	return (
		<Panel id="resource-profiles" title="Resource profiles">
			<form
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				<div className="grid gap-5 p-4">
					<p className="text-sm text-pretty text-muted-foreground">
						Sizes to pick from when creating or editing a service. A service
						copies the limits, so changing a profile here leaves existing
						services as they are. Leave CPU or memory empty for no limit.
					</p>
					<div className="grid gap-2">
						<div
							aria-hidden
							className="grid grid-cols-[minmax(0,1fr)_4.5rem_5.5rem_2rem] sm:grid-cols-[minmax(0,1fr)_6rem_7rem_2rem] gap-2 text-xs text-muted-foreground"
						>
							<span>Name</span>
							<span>CPU (cores)</span>
							<span>Memory (MB)</span>
						</div>
						<ul className="grid gap-2">
							{draft.profiles.map((p, i) => (
								<li
									// Rows are positional; a name can be edited or briefly duplicated.
									// biome-ignore lint/suspicious/noArrayIndexKey: see above
									key={i}
									className="grid grid-cols-[minmax(0,1fr)_4.5rem_5.5rem_2rem] sm:grid-cols-[minmax(0,1fr)_6rem_7rem_2rem] items-center gap-2"
								>
									<Input
										aria-label={`Name of profile ${i + 1}`}
										value={p.name}
										maxLength={40}
										readOnly={!canEdit}
										onChange={(e) => setProfile(i, { name: e.target.value })}
									/>
									<Input
										aria-label={`CPU cores for ${p.name || `profile ${i + 1}`}`}
										type="number"
										step="0.25"
										min={0}
										className="tabular-nums"
										readOnly={!canEdit}
										value={p.cpu ?? ""}
										onChange={(e) =>
											setProfile(i, { cpu: num(e.target.value) })
										}
									/>
									<Input
										aria-label={`Memory in megabytes for ${p.name || `profile ${i + 1}`}`}
										type="number"
										step="64"
										min={0}
										className="tabular-nums"
										readOnly={!canEdit}
										value={p.memoryMb ?? ""}
										onChange={(e) =>
											setProfile(i, { memoryMb: num(e.target.value) })
										}
									/>
									{canEdit && (
										<Button
											type="button"
											variant="ghost"
											size="icon"
											aria-label={`Remove ${p.name || `profile ${i + 1}`}`}
											onClick={() => remove(i)}
										>
											<Trash2 />
										</Button>
									)}
								</li>
							))}
						</ul>
						{canEdit && (
							<div>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									disabled={draft.profiles.length >= 50}
									onClick={() =>
										setDraft({
											...draft,
											profiles: [...draft.profiles, { name: "" }],
										})
									}
								>
									<Plus />
									Add profile
								</Button>
							</div>
						)}
					</div>
					<Field
						id="default-resource-profile"
						label="Default for new services"
						hint="Applied when a new service doesn't pick a profile or set its own limits."
						className="max-w-sm"
					>
						<Select
							disabled={!canEdit}
							value={draft.defaultProfile ?? NONE}
							onValueChange={(v) =>
								setDraft({ ...draft, defaultProfile: v === NONE ? null : v })
							}
						>
							<SelectTrigger id="default-resource-profile" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={NONE}>No default (unlimited)</SelectItem>
								{draft.profiles
									.filter((p) => p.name.trim())
									.map((p) => (
										<SelectItem key={p.name} value={p.name}>
											{p.name}
										</SelectItem>
									))}
							</SelectContent>
						</Select>
					</Field>
				</div>
				{canEdit && (
					<div className="flex items-center justify-end gap-3 border-t px-4 py-3">
						{dirty && issue && (
							<p className="mr-auto text-sm text-bad-text" aria-live="polite">
								{issue}
							</p>
						)}
						{dirty && (
							<Button
								type="button"
								variant="ghost"
								onClick={() => setDraft(saved)}
							>
								Discard
							</Button>
						)}
						<Button
							type="submit"
							disabled={!dirty || !parsed.success || save.isPending}
						>
							{save.isPending ? "Saving…" : "Save"}
						</Button>
					</div>
				)}
			</form>
		</Panel>
	);
}
