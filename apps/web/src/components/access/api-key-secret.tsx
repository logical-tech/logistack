import { TriangleAlert } from "lucide-react";
import { CopyLine, mcpCommand } from "@/components/access/mcp-section";
import type { CreatedApiKey } from "@/lib/api/access-types";

/** The one time a key's secret is visible: the key, then the MCP command with it filled in. */
export function SecretReveal({ created }: { created: CreatedApiKey }) {
	return (
		<div className="grid gap-5">
			<div className="flex items-start gap-3 rounded-lg bg-warn/10 px-3.5 py-3 text-sm">
				<TriangleAlert
					className="mt-0.5 size-4 shrink-0 text-warn-text"
					aria-hidden
				/>
				<p>
					<span className="font-medium">Copy the key now.</span>{" "}
					<span className="text-muted-foreground">
						LogiStack stores only its hash, so you won't see it again. Lost it?
						Rotate the key to get a new one.
					</span>
				</p>
			</div>
			<div className="grid gap-1.5">
				<span className="text-sm font-medium">{created.name ?? "API key"}</span>
				<CopyLine value={created.key} label="API key" wrap />
			</div>
			<div className="grid gap-1.5">
				<span className="text-sm font-medium">Connect Claude Code</span>
				<CopyLine
					value={mcpCommand(created.key)}
					label="Claude Code command"
					wrap
				/>
			</div>
		</div>
	);
}
