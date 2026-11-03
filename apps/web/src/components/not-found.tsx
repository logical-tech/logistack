import { Link } from "@tanstack/react-router";
import { Compass } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { Page } from "@/components/page-header";
import { Button } from "@/components/ui/button";

export function NotFound() {
	return (
		<Page className="max-w-xl pt-24">
			<EmptyState
				icon={Compass}
				title="This page doesn't exist"
				description="The link may be old, or the resource was removed. Search with ⌘K or head back home."
			>
				<Button asChild>
					<Link to="/">Go to Home</Link>
				</Button>
			</EmptyState>
		</Page>
	);
}
