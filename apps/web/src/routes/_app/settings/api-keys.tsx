import { createFileRoute, Link } from "@tanstack/react-router";
import { KeyRound, Plus } from "lucide-react";
import { ApiKeyTable } from "@/components/access/api-key-table";
import { McpSection } from "@/components/access/mcp-section";
import { ServiceAccountPanel } from "@/components/access/service-account-panel";
import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import {
	apiKeysQuery,
	serviceAccountsQuery,
	useApiKeys,
} from "@/lib/api/access";

export const Route = createFileRoute("/_app/settings/api-keys")({
	staticData: { crumb: "API keys" },
	loader: ({ context }) => {
		void context.queryClient.prefetchQuery(apiKeysQuery);
		void context.queryClient.prefetchQuery(serviceAccountsQuery);
	},
	component: ApiKeysPage,
});

function CreateKeyButton({ variant }: { variant?: "outline" }) {
	return (
		<Button asChild variant={variant}>
			<Link to="/settings/api-keys/new">
				<Plus data-icon="inline-start" />
				Create API key
			</Link>
		</Button>
	);
}

function ApiKeysPage() {
	const { data: keys } = useApiKeys();
	return (
		<Page>
			<PageHeader
				title="API keys"
				description="Keys for the REST API and the MCP server. Stored hashed and shown once; each one acts with its owner's access, narrowed to its scopes."
				actions={<CreateKeyButton />}
			/>
			<div className="grid gap-10">
				{keys && keys.length === 0 ? (
					<EmptyState
						icon={KeyRound}
						title="No API keys"
						description="Create a key for CI or for an agent. Keys start with lsk_, can be limited to a folder or project, and can expire."
					>
						<CreateKeyButton variant="outline" />
					</EmptyState>
				) : (
					<Panel title="Keys" id="keys">
						{keys ? <ApiKeyTable keys={keys} /> : <SkeletonRows rows={4} />}
					</Panel>
				)}
				<ServiceAccountPanel />
				<McpSection />
			</div>
		</Page>
	);
}
