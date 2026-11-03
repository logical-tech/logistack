import { ServiceBackups } from "@/components/backups/service-backups";
import type { ServiceOverview } from "@/lib/api/service-ops";
import type { ServiceId } from "@/lib/api/types";

/** The Backups tab: policies, runs and restores of this service. */
export function ServiceBackupsSlot({
	serviceId,
}: {
	serviceId: ServiceId;
	service: ServiceOverview;
}) {
	return <ServiceBackups serviceId={serviceId} />;
}
