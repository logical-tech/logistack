import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Boxes, FolderPlus, LogOut, Moon, Plus, Sun } from "lucide-react";
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
import { projectsQuery } from "@/lib/api/projects";
import { auth } from "@/lib/auth";
import { NAV } from "@/lib/nav";
import { useTheme } from "@/lib/theme";

const CommandMenuContext = createContext<(open: boolean) => void>(() => {});
export const useCommandMenu = () => use(CommandMenuContext);

export function CommandMenuProvider({ children }: { children: ReactNode }) {
	const [open, setOpen] = useState(false);
	const navigate = useNavigate();
	const { resolved, setTheme } = useTheme();
	const { data: projects = [] } = useQuery({ ...projectsQuery, enabled: open });

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
				onOpenChange={setOpen}
				title="Command menu"
				description="Jump to a page, a project or an action"
				className="sm:max-w-lg"
			>
				<Command>
					<CommandInput placeholder="Search pages, projects and actions…" />
					<CommandList>
						<CommandEmpty>
							Nothing matches. Try a project or page name.
						</CommandEmpty>
						<CommandGroup heading="Actions">
							<CommandItem
								onSelect={run(() =>
									navigate({ to: "/projects", search: { create: "project" } }),
								)}
							>
								<Plus /> New project
							</CommandItem>
							<CommandItem
								onSelect={run(() =>
									navigate({ to: "/projects", search: { create: "folder" } }),
								)}
							>
								<FolderPlus /> New folder
							</CommandItem>
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
						{projects.length > 0 && (
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
						{NAV.map((g) => (
							<CommandGroup key={g.label ?? "go"} heading={g.label ?? "Go to"}>
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
