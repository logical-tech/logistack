import { CopyButton } from "@/components/access/copy-button";
import { Panel } from "@/components/panel";
import { cn } from "@/lib/utils";

export const mcpEndpoint = () => `${window.location.origin}/mcp`;

export const mcpCommand = (key = "lsk_...") =>
	`claude mcp add --transport http logistack ${mcpEndpoint()} --header "Authorization: Bearer ${key}"`;

/** A copyable line of data: an endpoint, a key, a command. */
export function CopyLine({
	value,
	label,
	wrap,
	className,
}: {
	value: string;
	label: string;
	/** Break long values instead of scrolling them (commands). */
	wrap?: boolean;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex items-start gap-2 rounded-lg bg-muted/60 py-1.5 pr-1.5 pl-3 dark:bg-muted/40",
				className,
			)}
		>
			<code
				className={cn(
					"min-w-0 flex-1 py-1 font-mono text-xs leading-5 select-all",
					// Break at spaces first; split a long token (a key) only where it must.
					wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "truncate",
				)}
			>
				{value}
			</code>
			<CopyButton value={value} label={label} />
		</div>
	);
}

export function McpSection() {
	return (
		<Panel title="MCP server" id="mcp">
			<div className="grid gap-5 p-4 sm:p-5">
				<p className="max-w-[68ch] text-sm text-muted-foreground">
					Agents such as Claude Code drive LogiStack through its MCP server.
					Every REST operation is a tool, and each call acts with the key's
					permissions and lands in the audit log. Destructive tools (delete,
					stop, restore, rollback) only run with an explicit{" "}
					<code className="font-mono text-xs text-foreground">
						confirm: true
					</code>
					.
				</p>
				<div className="grid gap-1.5">
					<span className="text-sm font-medium">Endpoint</span>
					<CopyLine value={mcpEndpoint()} label="MCP endpoint" />
				</div>
				<div className="grid gap-1.5">
					<span className="text-sm font-medium">Claude Code</span>
					<CopyLine value={mcpCommand()} label="Claude Code command" wrap />
					<span className="text-xs text-muted-foreground">
						Replace lsk_... with a key. Creating a key shows this command with
						the key filled in.
					</span>
				</div>
			</div>
		</Panel>
	);
}
