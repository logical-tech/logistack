import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { Wordmark } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";

export const Route = createFileRoute("/_auth")({
	component: AuthLayout,
});

function AuthLayout() {
	return (
		<div className="flex min-h-dvh flex-col">
			<header className="flex items-center justify-between px-4 py-4 sm:px-6">
				<Link to="/sign-in" className="rounded-md" aria-label="LogiStack">
					<Wordmark />
				</Link>
				<ThemeToggle />
			</header>
			<main className="flex flex-1 items-start justify-center px-4 pt-[min(12vh,7rem)] pb-16 sm:items-center sm:pt-0">
				<div className="t-reveal w-full max-w-[22rem]">
					<Outlet />
				</div>
			</main>
			<footer className="px-4 pb-6 text-center text-xs text-muted-foreground">
				LogiStack runs on your own servers.
			</footer>
		</div>
	);
}
