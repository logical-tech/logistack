import { createFileRoute } from "@tanstack/react-router";
import { Plus, TerminalSquare, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/access/confirm-dialog";
import { CopyButton } from "@/components/access/copy-button";
import { AddSshKeyDialog } from "@/components/access/ssh-key-dialog";
import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { sshKeysQuery, useRemoveSshKey, useSshKeys } from "@/lib/api/access";
import type { SshKey } from "@/lib/api/access-types";
import { relativeTime } from "@/lib/format";

export const Route = createFileRoute("/_app/settings/ssh-keys")({
	staticData: { crumb: "SSH keys" },
	loader: ({ context }) => {
		void context.queryClient.prefetchQuery(sshKeysQuery);
	},
	component: SshKeysPage,
});

/** `ssh-ed25519 AAAAC3…f3Kj`: type, the head and tail of the key body. */
function shortKey(publicKey: string) {
	const [type, body = ""] = publicKey.split(" ");
	return body.length > 24
		? `${type} ${body.slice(0, 12)}…${body.slice(-8)}`
		: publicKey;
}

function SshKeyRow({ k, onDelete }: { k: SshKey; onDelete: () => void }) {
	return (
		<li className="grid gap-x-4 gap-y-1.5 px-4 py-3.5 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-center">
			<div className="min-w-0">
				<span className="block truncate font-medium">{k.name}</span>
				<time
					dateTime={k.createdAt}
					title={new Date(k.createdAt).toLocaleString()}
					className="block text-xs text-muted-foreground"
				>
					Added {relativeTime(k.createdAt)}
				</time>
			</div>
			<div className="min-w-0 font-mono text-xs">
				<span className="block truncate" title={k.publicKey}>
					{shortKey(k.publicKey)}
				</span>
				<span className="block truncate text-muted-foreground">
					{k.fingerprint}
				</span>
			</div>
			<div className="flex items-center gap-1 max-sm:-ml-2.5 max-sm:row-start-3">
				<CopyButton
					value={k.publicKey}
					label={`public key of ${k.name}`}
					size="sm"
				>
					Copy public key
				</CopyButton>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={`Delete ${k.name}`}
					onClick={onDelete}
				>
					<Trash2 />
				</Button>
			</div>
		</li>
	);
}

function SshKeysPage() {
	const { data: keys } = useSshKeys();
	const remove = useRemoveSshKey();
	const [adding, setAdding] = useState(false);
	const [deleting, setDeleting] = useState<SshKey | null>(null);

	const add = (variant?: "outline") => (
		<Button variant={variant} onClick={() => setAdding(true)}>
			<Plus data-icon="inline-start" />
			Add SSH key
		</Button>
	);

	return (
		<Page>
			<PageHeader
				title="SSH keys"
				description="For private Git repositories and for bootstrapping new servers. Private keys are encrypted at rest and never leave the server."
				actions={add()}
			/>
			{keys && keys.length === 0 ? (
				<EmptyState
					icon={TerminalSquare}
					title="No SSH keys"
					description="Generate an ed25519 key or import one, then add its public half as a deploy key or to a server."
				>
					{add("outline")}
				</EmptyState>
			) : (
				<Panel title="Keys" id="ssh-keys">
					{keys ? (
						<ul className="divide-y">
							{keys.map((k) => (
								<SshKeyRow key={k.id} k={k} onDelete={() => setDeleting(k)} />
							))}
						</ul>
					) : (
						<SkeletonRows rows={2} />
					)}
				</Panel>
			)}

			<AddSshKeyDialog open={adding} onOpenChange={setAdding} />
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
				title={`Delete ${deleting?.name}?`}
				description="Repositories and servers that trust this key stop accepting it from LogiStack. The private key is erased and can't be recovered."
				confirmLabel="Delete key"
				onConfirm={() =>
					remove.mutateAsync(deleting?.id ?? "").then(
						() => toast.success(`${deleting?.name} deleted`),
						(err: Error) => {
							toast.error("Couldn't delete the key", {
								description: err.message,
							});
							throw err;
						},
					)
				}
			/>
		</Page>
	);
}
