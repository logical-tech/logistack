import { Link, useMatches, useNavigate } from "@tanstack/react-router";
import { Bell, LogOut, Search, UserRound } from "lucide-react";
import { Fragment } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useSurfaces } from "@/components/work/shell/work-nav";
import { RunningTimerPill } from "@/components/work/time/running-timer-pill";
import { auth, useSessionUser } from "@/lib/auth";
import { useCommandMenu } from "./command-menu";

type Crumb = { label: string; to: string };

/** Each route contributes a crumb through `staticData.crumb` or loader data. */
function useCrumbs(): Crumb[] {
	return useMatches({
		select: (matches) =>
			matches.flatMap((m) => {
				const fromLoader = (m.loaderData as { crumb?: string } | undefined)
					?.crumb;
				const label = fromLoader ?? m.staticData.crumb;
				return label ? [{ label, to: m.pathname }] : [];
			}),
		structuralSharing: true,
	});
}

function Crumbs() {
	const crumbs = useCrumbs();
	return (
		<Breadcrumb className="min-w-0">
			<BreadcrumbList className="flex-nowrap">
				{crumbs.map((c, i) => {
					const last = i === crumbs.length - 1;
					return (
						<Fragment key={c.to}>
							{i > 0 && <BreadcrumbSeparator className="max-sm:hidden" />}
							<BreadcrumbItem className={last ? "min-w-0" : "max-sm:hidden"}>
								{last ? (
									<BreadcrumbPage className="truncate font-medium">
										{c.label}
									</BreadcrumbPage>
								) : (
									<BreadcrumbLink asChild>
										<Link to={c.to}>{c.label}</Link>
									</BreadcrumbLink>
								)}
							</BreadcrumbItem>
						</Fragment>
					);
				})}
			</BreadcrumbList>
		</Breadcrumb>
	);
}

function UserMenu() {
	const user = useSessionUser();
	const navigate = useNavigate();
	const initials = (user?.name ?? "?")
		.split(" ")
		.map((p) => p[0])
		.slice(0, 2)
		.join("");
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="rounded-full"
					aria-label="Account"
				>
					<Avatar className="size-7">
						<AvatarFallback className="bg-foreground text-2xs font-semibold text-background">
							{initials}
						</AvatarFallback>
					</Avatar>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-60">
				<DropdownMenuLabel className="grid gap-0.5 font-normal">
					<span className="text-sm font-medium text-foreground">
						{user?.name}
					</span>
					<span className="truncate text-xs text-muted-foreground">
						{user?.email}
					</span>
				</DropdownMenuLabel>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuItem
						onSelect={() => navigate({ to: "/account/security" })}
					>
						<UserRound /> Account and security
					</DropdownMenuItem>
					<DropdownMenuItem
						onSelect={() => navigate({ to: "/account/notifications" })}
					>
						<Bell /> Notifications
					</DropdownMenuItem>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					onSelect={async () => {
						await auth.signOut();
						await navigate({ to: "/sign-in" });
					}}
				>
					<LogOut /> Sign out
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export function TopBar() {
	const openMenu = useCommandMenu();
	const { work } = useSurfaces();
	return (
		<header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-3 sm:px-4">
			<SidebarTrigger className="-ml-1 text-muted-foreground" />
			<Crumbs />
			<div className="ml-auto flex items-center gap-1">
				{work && <RunningTimerPill className="mr-1" />}
				<Button
					variant="outline"
					onClick={() => openMenu(true)}
					className="hidden w-56 justify-start gap-2 bg-muted/50 text-muted-foreground shadow-none hover:text-foreground md:inline-flex dark:bg-muted/30"
				>
					<Search className="size-3.5" />
					<span className="text-sm font-normal">Search…</span>
					<Kbd className="ml-auto bg-background">⌘K</Kbd>
				</Button>
				<Button
					variant="ghost"
					size="icon"
					className="md:hidden"
					aria-label="Search"
					onClick={() => openMenu(true)}
				>
					<Search />
				</Button>
				<ThemeToggle />
				<UserMenu />
			</div>
		</header>
	);
}
