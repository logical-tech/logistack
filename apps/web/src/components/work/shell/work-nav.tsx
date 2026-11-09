/*
 * Work navigation. Ops + Work actors get a "Tasks" group in the normal sidebar; Work-only actors
 * (project managers, guests) get their own sidebar with nothing about deployments (section 3).
 */
import { Link, useRouterState } from "@tanstack/react-router";
import {
	ChartGantt,
	Clock,
	Import,
	Inbox,
	LayoutGrid,
	type LucideIcon,
	UserRound,
	UserRoundCheck,
} from "lucide-react";
import { OrgSwitcher } from "@/components/shell/app-sidebar";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuBadge,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarRail,
	useSidebar,
} from "@/components/ui/sidebar";
import { useMe } from "@/lib/api/access";
import { useWorkInbox, useWorkProjects } from "@/lib/api/work-queries";
import { cn } from "@/lib/utils";
import { HealthDot } from "../parts";

/** Which shells the actor may use, from `/api/me` (an actor without the field is ops-only). */
export function useSurfaces() {
	const { data: me } = useMe();
	const surfaces = (me as { surfaces?: string[] } | undefined)?.surfaces ?? [
		"ops",
	];
	return {
		ops: surfaces.includes("ops"),
		work: surfaces.includes("work"),
		workOnly: surfaces.includes("work") && !surfaces.includes("ops"),
	};
}

/** Owners, admins and project managers can import into a project they administer. */
const IMPORT_ROLES = new Set(["owner", "admin", "manager"]);

/**
 * Whether to offer Import. shortcut: role names only (a custom role holding `work:admin` doesn't
 * see the link, though the page works); expose actions on /me to tighten this.
 */
export function useCanImport() {
	const { data: me } = useMe();
	return !!me?.grants.some((g) => IMPORT_ROLES.has(g.role));
}

export function useInboxUnread() {
	const inbox = useWorkInbox(true);
	return inbox.data?.pages[0]?.unread ?? 0;
}

const isActive = (pathname: string, to: string, exact = false) =>
	exact ? pathname === to : pathname === to || pathname.startsWith(`${to}/`);

type NavPath =
	| "/work"
	| "/work/inbox"
	| "/work/time"
	| "/work/workload"
	| "/work/import"
	| "/work/projects"
	| "/account/security";

function NavItem({
	to,
	icon: Icon,
	label,
	active,
	badge,
}: {
	to: NavPath;
	icon: LucideIcon;
	label: string;
	active: boolean;
	badge?: number;
}) {
	const { isMobile, setOpenMobile } = useSidebar();
	return (
		<SidebarMenuItem>
			<SidebarMenuButton asChild isActive={active} tooltip={label}>
				<Link to={to} onClick={() => isMobile && setOpenMobile(false)}>
					<Icon
						strokeWidth={active ? 2 : 1.75}
						className={cn(!active && "text-muted-foreground")}
					/>
					<span>{label}</span>
				</Link>
			</SidebarMenuButton>
			{!!badge && (
				<SidebarMenuBadge
					aria-label={`${badge} unread`}
					className="bg-brand/12 text-brand peer-data-active/menu-button:text-brand"
				>
					{badge > 99 ? "99+" : badge}
				</SidebarMenuBadge>
			)}
		</SidebarMenuItem>
	);
}

function ProjectItems({ variant }: { variant: "work" | "ops" }) {
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const { data: projects = [] } = useWorkProjects();
	const { isMobile, setOpenMobile } = useSidebar();
	return (
		<>
			{projects
				.filter((p) => !p.archived)
				.map((p) => {
					const to =
						variant === "work"
							? `/work/projects/${p.id}`
							: `/projects/${p.id}/tasks`;
					const active = isActive(pathname, to);
					return (
						<SidebarMenuItem key={p.id}>
							<SidebarMenuButton asChild isActive={active} tooltip={p.name}>
								<Link
									to={
										variant === "work"
											? "/work/projects/$projectId"
											: "/projects/$projectId/tasks"
									}
									params={{ projectId: p.id }}
									onClick={() => isMobile && setOpenMobile(false)}
								>
									<span className="grid size-4 place-items-center">
										{variant === "work" && p.hasServices ? (
											<HealthDot health={p.health} />
										) : (
											<span
												aria-hidden
												className="text-2xs font-semibold text-muted-foreground"
											>
												{p.key.slice(0, 2)}
											</span>
										)}
									</span>
									<span className="truncate">{p.name}</span>
								</Link>
							</SidebarMenuButton>
							{p.counts.open > 0 && (
								<SidebarMenuBadge
									aria-label={`${p.counts.open} open tasks`}
									className="text-muted-foreground"
								>
									{p.counts.open}
								</SidebarMenuBadge>
							)}
						</SidebarMenuItem>
					);
				})}
		</>
	);
}

/** Time, Workload and (for project admins) Import: the same three in both shells. */
function ToolItems({ pathname }: { pathname: string }) {
	const canImport = useCanImport();
	return (
		<>
			<NavItem
				to="/work/time"
				icon={Clock}
				label="Time"
				active={isActive(pathname, "/work/time")}
			/>
			<NavItem
				to="/work/workload"
				icon={ChartGantt}
				label="Workload"
				active={isActive(pathname, "/work/workload")}
			/>
			{canImport && (
				<NavItem
					to="/work/import"
					icon={Import}
					label="Import"
					active={isActive(pathname, "/work/import")}
				/>
			)}
		</>
	);
}

/** "Tasks" in the ops sidebar: My tasks, Inbox, the tools, then projects with open-task counts. */
export function WorkNavGroup() {
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const unread = useInboxUnread();
	return (
		<SidebarGroup>
			<SidebarGroupLabel>Tasks</SidebarGroupLabel>
			<SidebarGroupContent>
				<SidebarMenu>
					<NavItem
						to="/work"
						icon={UserRoundCheck}
						label="My tasks"
						active={isActive(pathname, "/work", true)}
					/>
					<NavItem
						to="/work/inbox"
						icon={Inbox}
						label="Inbox"
						badge={unread}
						active={isActive(pathname, "/work/inbox")}
					/>
					<ToolItems pathname={pathname} />
					<ProjectItems variant="ops" />
				</SidebarMenu>
			</SidebarGroupContent>
		</SidebarGroup>
	);
}

/** The whole sidebar of the Work shell. */
export function WorkSidebar() {
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const unread = useInboxUnread();
	return (
		<Sidebar collapsible="icon">
			<SidebarHeader>
				<OrgSwitcher />
			</SidebarHeader>
			<SidebarContent>
				<SidebarGroup>
					<SidebarGroupContent>
						<SidebarMenu>
							<NavItem
								to="/work"
								icon={UserRoundCheck}
								label="My tasks"
								active={isActive(pathname, "/work", true)}
							/>
							<NavItem
								to="/work/inbox"
								icon={Inbox}
								label="Inbox"
								badge={unread}
								active={isActive(pathname, "/work/inbox")}
							/>
							<ToolItems pathname={pathname} />
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>
				<SidebarGroup>
					<SidebarGroupLabel>Projects</SidebarGroupLabel>
					<SidebarGroupContent>
						<SidebarMenu>
							<NavItem
								to="/work/projects"
								icon={LayoutGrid}
								label="All projects"
								active={isActive(pathname, "/work/projects", true)}
							/>
							<ProjectItems variant="work" />
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>
			</SidebarContent>
			<SidebarFooter>
				<SidebarMenu>
					<NavItem
						to="/account/security"
						icon={UserRound}
						label="Account"
						active={isActive(pathname, "/account")}
					/>
				</SidebarMenu>
			</SidebarFooter>
			<SidebarRail />
		</Sidebar>
	);
}
