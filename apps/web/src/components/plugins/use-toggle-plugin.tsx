import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useInvalidating } from "@/lib/api/networking";
import { type PluginInstall, pluginsApi } from "@/lib/api/plugins";

/** Off is the kill switch, so it asks first; on goes straight through. */
export function useTogglePlugin() {
	const [stopping, setStopping] = useState<PluginInstall | null>(null);
	const update = useInvalidating(
		({ id, enabled }: { id: string; enabled: boolean }) =>
			pluginsApi.update(id, { enabled }),
		[["plugins"]],
	);
	const set = (p: PluginInstall, enabled: boolean) =>
		update.mutateAsync({ id: p.id, enabled }).then(
			() => {
				toast.success(enabled ? `${p.name} turned on` : `${p.name} turned off`);
			},
			(err: unknown) => {
				toast.error(`Couldn't change ${p.name}`, {
					description: err instanceof Error ? err.message : String(err),
				});
				throw err;
			},
		);
	const toggle = (p: PluginInstall, enabled: boolean) =>
		enabled ? void set(p, true).catch(() => {}) : setStopping(p);
	const dialog = (
		<ConfirmDialog
			open={stopping !== null}
			onOpenChange={(o) => !o && setStopping(null)}
			title={`Turn off ${stopping?.name ?? "plugin"}?`}
			description="Its container stops and its pages, tools and events disappear for everyone in the organization. Settings and data stay; turn it on again any time."
			confirmLabel="Turn off"
			pending={update.isPending}
			onConfirm={() => {
				if (stopping)
					void set(stopping, false).then(
						() => setStopping(null),
						() => {},
					);
			}}
		/>
	);
	return { toggle, dialog, busy: update.isPending };
}
