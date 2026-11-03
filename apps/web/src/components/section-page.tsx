import { Plus } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { section } from "@/lib/nav";

/** A finished-looking page for a section whose screens are not built yet. */
export function SectionPage({ to }: { to: string }) {
	const s = section(to);
	const empty = s.empty;
	const announce = () =>
		toast(`${empty?.action ?? s.title} opens a guided setup`, {
			description: "This flow arrives with its API. Nothing was changed.",
		});
	return (
		<Page>
			<PageHeader
				title={s.title}
				description={s.description}
				actions={
					empty && (
						<Button onClick={announce}>
							<Plus data-icon="inline-start" />
							{empty.action}
						</Button>
					)
				}
			/>
			{empty && (
				<EmptyState icon={s.icon} title={empty.title} description={empty.body}>
					<Button variant="outline" onClick={announce}>
						{empty.action}
					</Button>
				</EmptyState>
			)}
		</Page>
	);
}
