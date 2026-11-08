import { useQuery } from "@tanstack/react-query";
import { ChevronsUpDown, Lock } from "lucide-react";
import { useState } from "react";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import type { WizardApi } from "@/components/wizard/wizard";
import {
	branchesQuery,
	type GitRepo,
	reposQuery,
} from "@/lib/api/integrations";
import { cn } from "@/lib/utils";

/** Answers a wizard holds about a git source. */
type GitAnswers = { providerId: string; repository: string; branch: string };
// The pickers write only these three keys, so any wizard whose answers include them can use them.
type GitWizard = Pick<WizardApi<GitAnswers>, "values" | "error" | "bind"> & {
	set: (key: keyof GitAnswers, value: string) => void;
};

/** Searchable repository list of a git provider; picking one also picks its default branch. */
export function RepoPicker({ w }: { w: GitWizard }) {
	const { data: repos, isPending } = useQuery(reposQuery(w.values.providerId));
	const [open, setOpen] = useState(false);
	const value = w.values.repository;
	const pick = (r: GitRepo) => {
		w.set("repository", r.fullName);
		w.set("branch", r.defaultBranch ?? "main");
		setOpen(false);
	};
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					id="wz-repository"
					type="button"
					variant="outline"
					role="combobox"
					aria-expanded={open}
					aria-invalid={w.error("repository") ? true : undefined}
					aria-describedby="wz-repository-msg"
					className="h-8 w-full justify-between font-normal"
				>
					<span
						className={cn(
							"truncate",
							value ? "font-mono text-sm" : "text-muted-foreground",
						)}
					>
						{value ||
							(isPending ? "Loading repositories…" : "Choose a repository")}
					</span>
					<ChevronsUpDown className="opacity-50" aria-hidden />
				</Button>
			</PopoverTrigger>
			<PopoverContent
				className="w-(--radix-popover-trigger-width) p-0"
				align="start"
			>
				<Command>
					<CommandInput placeholder="Search repositories" />
					<CommandList>
						<CommandEmpty>
							{isPending ? "Loading…" : "No repository matches."}
						</CommandEmpty>
						<CommandGroup>
							{repos?.map((r) => (
								<CommandItem
									key={r.fullName}
									value={r.fullName}
									data-checked={r.fullName === value}
									onSelect={() => pick(r)}
								>
									<span className="min-w-0 flex-1 truncate font-mono text-xs">
										{r.fullName}
									</span>
									{r.private && (
										<Lock
											className="size-3.5 text-muted-foreground"
											aria-label="Private"
										/>
									)}
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

/** The branch: a list when the provider lists branches, a text field otherwise. */
export function BranchField({ w }: { w: GitWizard }) {
	const { providerId, repository, branch } = w.values;
	const { data: branches } = useQuery(branchesQuery(providerId, repository));
	// Generic SSH remotes list no branches: the branch is typed by hand.
	const choices = branches?.length
		? [...new Set([branch, ...branches].filter(Boolean))]
		: null;
	return (
		<Field id="wz-branch" label="Branch" error={w.error("branch")}>
			{choices ? (
				<Select value={branch} onValueChange={(b) => w.set("branch", b)}>
					<SelectTrigger id="wz-branch" className="w-full font-mono">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{choices.map((b) => (
							<SelectItem key={b} value={b} className="font-mono">
								{b}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			) : (
				<Input {...w.bind("branch")} className="font-mono" spellCheck={false} />
			)}
		</Field>
	);
}
