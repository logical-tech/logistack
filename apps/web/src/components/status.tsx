import { useRef } from "react";
import type {
	DeploymentStatus,
	NodeStatus,
	ObservedStatus,
} from "@/lib/api/types";
import {
	DEPLOYMENT_STATUS,
	NODE_STATUS,
	SERVICE_STATUS,
	type StatusMeta,
	TONE_DOT,
	TONE_TEXT,
} from "@/lib/status";
import { cn } from "@/lib/utils";

/** True once `value` differs from what the component first rendered with. */
function useHasChanged<T>(value: T) {
	const first = useRef(value);
	const changed = useRef(false);
	if (value !== first.current) changed.current = true;
	return changed.current;
}

export function StatusDot({
	meta,
	className,
}: {
	meta: StatusMeta;
	className?: string;
}) {
	return (
		<span
			aria-hidden
			className={cn("relative inline-flex size-2 shrink-0", className)}
		>
			{meta.live && (
				<span
					className={cn(
						"t-ping absolute inset-0 rounded-full",
						TONE_DOT[meta.tone],
					)}
				/>
			)}
			<span
				className={cn(
					"relative size-2 rounded-full transition-colors duration-(--duration-slow)",
					TONE_DOT[meta.tone],
				)}
			/>
		</span>
	);
}

export function StatusLabel({
	meta,
	className,
	suffix,
}: {
	meta: StatusMeta;
	className?: string;
	suffix?: string;
}) {
	const changed = useHasChanged(meta.label);
	const loud = meta.tone === "bad" || meta.tone === "warn";
	return (
		<span
			className={cn(
				"inline-flex items-center gap-2 text-sm whitespace-nowrap",
				loud ? TONE_TEXT[meta.tone] : "text-foreground",
				className,
			)}
		>
			<StatusDot meta={meta} />
			<span key={meta.label} className={cn(changed && "t-swap")}>
				{meta.label}
				{suffix && <span className="text-muted-foreground"> {suffix}</span>}
			</span>
		</span>
	);
}

export const ServiceStatus = ({
	status,
	className,
	suffix,
}: {
	status: ObservedStatus;
	className?: string;
	suffix?: string;
}) => (
	<StatusLabel
		meta={SERVICE_STATUS[status]}
		className={className}
		suffix={suffix}
	/>
);

export const DeploymentStatusLabel = ({
	status,
	className,
}: {
	status: DeploymentStatus;
	className?: string;
}) => <StatusLabel meta={DEPLOYMENT_STATUS[status]} className={className} />;

export const NodeStatusLabel = ({
	status,
	className,
}: {
	status: NodeStatus;
	className?: string;
}) => <StatusLabel meta={NODE_STATUS[status]} className={className} />;
