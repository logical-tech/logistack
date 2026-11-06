import Link from "next/link";

export default function NotFound() {
	return (
		<main className="mx-auto flex max-w-md flex-1 flex-col items-center justify-center gap-4 px-6 py-24 text-center">
			<p className="font-mono text-sm text-fd-muted-foreground">404</p>
			<h1 className="text-2xl font-semibold">This page isn't in the docs</h1>
			<p className="text-fd-muted-foreground">
				It may have moved. Search with <kbd className="font-mono">⌘K</kbd>, or
				start from the overview.
			</p>
			<Link
				href="/"
				className="rounded-full bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground"
			>
				Docs overview
			</Link>
		</main>
	);
}
