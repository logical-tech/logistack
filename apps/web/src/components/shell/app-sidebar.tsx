import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { LogoMark } from "@/components/brand";
import { UpdateBadge } from "@/components/shell/update-badge";
import { StatusDot } from "@/components/status";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarRail,
	useSidebar,
} from "@/components/ui/sidebar";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { versionQuery } from "@/lib/api/instance";
import { nodesQuery } from "@/lib/api/monitoring";
import { auth, type Org } from "@/lib/auth";
import { NAV } from "@/lib/nav";
import { NODE_STATUS } from "@/lib/status";
import { cn } from "@/lib/utils";

const orgsQuery = {
	queryKey: ["organizations"],
	queryFn: () => auth.listOrganizations(),
	staleTime: Number.POSITIVE_INFINITY,
};

function OrgSwitcher() {
	const { data: orgs = [] } = useQuery(orgsQuery);
	const [activeId, setActiveId] = useState<string | null>(null);
	const active: Org | undefined =
		orgs.find((o) => o.id === activeId) ?? orgs[0];

	return (
		<SidebarMenu>
			<SidebarMenuItem>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<SidebarMenuButton
							size="lg"
							className="data-[state=open]:bg-sidebar-accent"
							tooltip={active?.name ?? "Organization"}
						>
							<LogoMark className="size-8" />
							<span className="grid min-w-0 flex-1 leading-tight">
								<span className="truncate text-sm font-semibold">
									{active?.name ?? "…"}
								</span>
								<span className="truncate text-xs text-muted-foreground">
									Owner
								</span>
							</span>
							<ChevronsUpDown className="ml-auto text-muted-foreground" />
						</SidebarMenuButton>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						align="start"
						sideOffset={6}
						className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
					>
						<DropdownMenuLabel>Organizations</DropdownMenuLabel>
						{orgs.map((o) => (
							<DropdownMenuItem
								key={o.id}
								onSelect={async () => {
									setActiveId(o.id);
									await auth.setActiveOrganization(o.id);
									toast.success(`Switched to ${o.name}`);
								}}
							>
								<span className="grid size-5 place-items-center rounded-sm bg-muted text-2xs font-semibold">
									{o.name[0]}
								</span>
								{o.name}
								{o.id === active?.id && <Check className="ml-auto" />}
							</DropdownMenuItem>
						))}
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onSelect={() =>
								toast("Organizations are created from Settings → General", {
									description: "That screen ships with the organizations API.",
								})
							}
						>
							<Plus /> New organization
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</SidebarMenuItem>
		</SidebarMenu>
	);
}

function isActive(pathname: string, to: string) {
	return to === "/"
		? pathname === "/"
		: pathname === to || pathname.startsWith(`${to}/`);
}

const plural = (n: number, word: string) => `${word}${n === 1 ? "" : "s"}`;

/**
 * The foot of the sidebar: cluster health on the left, the LogiStack version on the right.
 * Collapsed, the dot alone stays and its tooltip carries everything, version included.
 */
function FooterStatus() {
	const { data: nodes = [] } = useQuery(nodesQuery);
	const { data: build } = useQuery(versionQuery);
	const { state, isMobile } = useSidebar();
	const collapsed = state === "collapsed" && !isMobile;
	const ready = nodes.filter((n) => n.status === "ready").length;
	const down = nodes.filter((n) => n.status === "down");
	const meta = down.length
		? NODE_STATUS.down
		: ready < nodes.length
			? NODE_STATUS.pending
			: NODE_STATUS.ready;
	const version =
		build && (/^\d/.test(build.version) ? `v${build.version}` : build.version);
	const release = build && (
		<span className="font-mono">
			LogiStack {version}
			{build.commit && ` · ${build.commit.slice(0, 7)}`}
		</span>
	);
	const sentence = `${ready} of ${nodes.length} ${plural(nodes.length, "node")} ready`;

	return (
		<div className="flex h-8 items-center justify-between gap-2 pr-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:pr-0">
			{nodes.length > 0 && (
				<Tooltip>
					<TooltipTrigger asChild>
						<Link
							to="/monitoring"
							aria-label={`${sentence}${down.length ? `, ${down.length} down` : ""}`}
							className="t-press inline-flex h-8 min-w-8 items-center justify-center gap-2 rounded-md px-2 text-xs text-muted-foreground outline-none transition-[background-color,color] duration-(--duration-quick) hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
						>
							<StatusDot meta={meta} />
							<span className="tabular whitespace-nowrap group-data-[collapsible=icon]:hidden">
								{ready}/{nodes.length} {plural(nodes.length, "node")}
							</span>
						</Link>
					</TooltipTrigger>
					<TooltipContent
						side={collapsed ? "right" : "top"}
						align={collapsed ? "center" : "start"}
						className="flex-col items-start gap-0.5"
					>
						<span>{sentence}</span>
						{down.length > 0 && (
							<span>Down: {down.map((n) => n.hostname).join(", ")}</span>
						)}
						{collapsed && release && (
							<span className="opacity-70">{release}</span>
						)}
					</TooltipContent>
				</Tooltip>
			)}
			{version && !collapsed && (
				<Tooltip>
					<TooltipTrigger asChild>
						<span
							// biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users reach the commit tooltip too.
							tabIndex={0}
							className="ml-auto truncate rounded-sm font-mono text-2xs text-muted-foreground tabular outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
						>
							{version}
						</span>
					</TooltipTrigger>
					<TooltipContent side="top" align="end">
						{release}
					</TooltipContent>
				</Tooltip>
			)}
		</div>
	);
}

export function AppSidebar() {
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const { isMobile, setOpenMobile } = useSidebar();

	return (
		<Sidebar collapsible="icon">
			<SidebarHeader>
				<OrgSwitcher />
			</SidebarHeader>
			<SidebarContent>
				{NAV.map((group) => (
					<SidebarGroup key={group.label ?? "main"}>
						{group.label && (
							<SidebarGroupLabel>{group.label}</SidebarGroupLabel>
						)}
						<SidebarGroupContent>
							<SidebarMenu>
								{group.items.map((item) => {
									const active = isActive(pathname, item.to);
									return (
										<SidebarMenuItem key={item.to}>
											<SidebarMenuButton
												asChild
												isActive={active}
												tooltip={item.title}
											>
												<Link
													to={item.to}
													onClick={() => isMobile && setOpenMobile(false)}
												>
													<item.icon
														strokeWidth={active ? 2 : 1.75}
														className={cn(!active && "text-muted-foreground")}
													/>
													<span>{item.title}</span>
												</Link>
											</SidebarMenuButton>
										</SidebarMenuItem>
									);
								})}
							</SidebarMenu>
						</SidebarGroupContent>
					</SidebarGroup>
				))}
			</SidebarContent>
			<SidebarFooter>
				<UpdateBadge />
				<FooterStatus />
			</SidebarFooter>
			<SidebarRail />
		</Sidebar>
	);
}
