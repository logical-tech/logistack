import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	Boxes,
	FolderPlus,
	Inbox,
	Keyboard,
	LayoutGrid,
	ListTodo,
	LogOut,
	Moon,
	Plus,
	ShieldBan,
	SquarePen,
	Sun,
	UserRoundCheck,
} from "lucide-react";
import { createContext, type ReactNode, use, useEffect, useState } from "react";
import {
	Command,
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandShortcut,
} from "@/components/ui/command";
import { TaskKey } from "@/components/work/parts";
import { useSurfaces } from "@/components/work/shell/work-nav";
import { useOpenTask } from "@/components/work/task-sheet/open-task";
import { useHomeDns } from "@/lib/api/home-dns";
import { projectsQuery } from "@/lib/api/projects";
import { useWorkSearch } from "@/lib/api/work-queries";
import { auth } from "@/lib/auth";
import { navGroups } from "@/lib/nav";
import { useTheme } from "@/lib/theme";

const CommandMenuContext = createContext<(open: boolean) => void>(() => {});
export const useCommandMenu = () => use(CommandMenuContext);

export function CommandMenuProvider({ children }: { children: ReactNode }) {
	const [open, setOpen] = useState(false);
	const navigate = useNavigate();
	const { resolved, setTheme } = useTheme();
	const { ops, work } = useSurfaces();
	const { data: projects = [] } = useQuery({
		...projectsQuery,
		enabled: open && ops,
	});
	const [query, setQuery] = useState("");
	const { data: hits } = useWorkSearch(work && open ? query.trim() : "");
	const openTask = useOpenTask();
	const homeDns = useHomeDns();
	const taskKey = /^[a-z][a-z0-9]{1,9}-\d+$/i.test(query.trim())
		? query.trim().toUpperCase()
		: null;

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				setOpen((o) => !o);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const run = (fn: () => unknown) => () => {
		setOpen(false);
		fn();
	};

	return (
		<CommandMenuContext value={setOpen}>
			{children}
			<CommandDialog
				open={open}
				onOpenChange={(o) => {
					setOpen(o);
					if (!o) setQuery("");
				}}
				title="Command menu"
				description="Jump to a page, a project or an action"
				className="sm:max-w-lg"
			>
				<Command>
					<CommandInput
						value={query}
						onValueChange={setQuery}
						placeholder={
							ops
								? "Search pages, projects, tasks and actions…"
								: "Search tasks, or type a key like SHOP-42…"
						}
					/>
					<CommandList>
						{!taskKey && !hits?.items.length && (
							<CommandEmpty>
								Nothing matches. Try a project or page name.
							</CommandEmpty>
						)}
						{work && (taskKey || (hits?.items.length ?? 0) > 0) && (
							<CommandGroup heading="Tasks" forceMount>
								{taskKey && (
									<CommandItem
										forceMount
										value={`go to ${taskKey}`}
										onSelect={run(() =>
											navigate({
												to: "/work/t/$key",
												params: { key: taskKey },
											}),
										)}
									>
										<ListTodo /> Go to {taskKey}
									</CommandItem>
								)}
								{hits?.items.map((h) => (
									<CommandItem
										key={h.id}
										forceMount
										value={`task ${h.key} ${h.title}`}
										onSelect={run(() => openTask(h.id))}
									>
										<TaskKey value={h.key} className="w-16 shrink-0" />
										<span className="min-w-0 flex-1 truncate">{h.title}</span>
										<span className="shrink-0 truncate text-xs text-muted-foreground">
											{h.projectName}
										</span>
									</CommandItem>
								))}
							</CommandGroup>
						)}
						{work && (
							<CommandGroup heading="Work">
								<CommandItem
									keywords={["create", "add", "todo"]}
									onSelect={run(() =>
										window.dispatchEvent(new CustomEvent("work:new-task")),
									)}
								>
									<SquarePen /> New task
									<CommandShortcut>C</CommandShortcut>
								</CommandItem>
								<CommandItem onSelect={run(() => navigate({ to: "/work" }))}>
									<UserRoundCheck /> My tasks
									<CommandShortcut>G M</CommandShortcut>
								</CommandItem>
								<CommandItem
									onSelect={run(() => navigate({ to: "/work/inbox" }))}
								>
									<Inbox /> Inbox
									<CommandShortcut>G I</CommandShortcut>
								</CommandItem>
								<CommandItem
									onSelect={run(() => navigate({ to: "/work/projects" }))}
								>
									<LayoutGrid /> Task projects
									<CommandShortcut>G P</CommandShortcut>
								</CommandItem>
								<CommandItem
									keywords={["shortcuts", "help", "keys"]}
									onSelect={run(() =>
										window.dispatchEvent(
											new KeyboardEvent("keydown", { key: "?" }),
										),
									)}
								>
									<Keyboard /> Keyboard shortcuts
									<CommandShortcut>?</CommandShortcut>
								</CommandItem>
							</CommandGroup>
						)}
						<CommandGroup heading="Actions">
							{ops && (
								<>
									<CommandItem
										onSelect={run(() =>
											navigate({
												to: "/projects",
												search: { create: "project" },
											}),
										)}
									>
										<Plus /> New project
									</CommandItem>
									<CommandItem
										onSelect={run(() =>
											navigate({
												to: "/projects",
												search: { create: "folder" },
											}),
										)}
									>
										<FolderPlus /> New folder
									</CommandItem>
								</>
							)}
							{ops && homeDns.admin && homeDns.data?.enabled === false && (
								<CommandItem
									keywords={[
										"dns",
										"home",
										"ad blocking",
										"technitium",
										"pihole",
									]}
									onSelect={run(() => navigate({ to: "/network/dns/new" }))}
								>
									<ShieldBan /> Turn on home network DNS
								</CommandItem>
							)}
							<CommandItem
								keywords={["theme", "dark", "light"]}
								onSelect={run(() =>
									setTheme(resolved === "dark" ? "light" : "dark"),
								)}
							>
								{resolved === "dark" ? <Sun /> : <Moon />}
								Switch to {resolved === "dark" ? "light" : "dark"} theme
							</CommandItem>
						</CommandGroup>
						{ops && projects.length > 0 && (
							<CommandGroup heading="Projects">
								{projects.map((p) => (
									<CommandItem
										key={p.id}
										value={`project ${p.name}`}
										keywords={p.description ? [p.description] : undefined}
										onSelect={run(() =>
											navigate({
												to: "/projects/$projectId",
												params: { projectId: p.id },
											}),
										)}
									>
										<Boxes /> {p.name}
										<span className="truncate text-xs text-muted-foreground">
											{p.description}
										</span>
									</CommandItem>
								))}
							</CommandGroup>
						)}
						{ops &&
							navGroups(homeDns.on).map((g) => (
								<CommandGroup
									key={g.label ?? "go"}
									heading={g.label ?? "Go to"}
								>
									{g.items.map((s) => (
										<CommandItem
											key={s.to}
											value={`${g.label ?? ""} ${s.title}`}
											keywords={s.keywords}
											onSelect={run(() => navigate({ to: s.to }))}
										>
											<s.icon /> {s.title}
										</CommandItem>
									))}
								</CommandGroup>
							))}
						<CommandGroup heading="Account">
							<CommandItem
								onSelect={run(async () => {
									await auth.signOut();
									await navigate({ to: "/sign-in" });
								})}
							>
								<LogOut /> Sign out
								<CommandShortcut>⇧⌘Q</CommandShortcut>
							</CommandItem>
						</CommandGroup>
					</CommandList>
				</Command>
			</CommandDialog>
		</CommandMenuContext>
	);
}
