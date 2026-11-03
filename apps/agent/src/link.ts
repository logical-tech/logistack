import {
	type AgentMessage,
	HIGH_WATER_BYTES,
	STALL_TIMEOUT_MS,
} from "@logistack/contracts";

export class BackpressureError extends Error {}
export class DisconnectedError extends Error {}

/** One live WebSocket to the server; outbound flow control lives here (policy in contracts/agent.ts). */
export class Link {
	static dropped = 0;
	constructor(private ws: WebSocket) {}

	get open() {
		return this.ws.readyState === WebSocket.OPEN;
	}

	/** Telemetry: dropped, not queued, while the socket is backed up. */
	send(m: AgentMessage): boolean {
		if (!this.open || this.ws.bufferedAmount > HIGH_WATER_BYTES) {
			Link.dropped++;
			return false;
		}
		this.ws.send(JSON.stringify(m));
		return true;
	}

	/** Stream output: waits for the socket to drain, so the caller stops reading its source. */
	async sendStream(m: AgentMessage): Promise<void> {
		const deadline = Date.now() + STALL_TIMEOUT_MS;
		while (this.open && this.ws.bufferedAmount > HIGH_WATER_BYTES) {
			if (Date.now() > deadline)
				throw new BackpressureError(
					`socket stalled above ${HIGH_WATER_BYTES} bytes for ${STALL_TIMEOUT_MS} ms`,
				);
			await Bun.sleep(20);
		}
		if (!this.open) throw new DisconnectedError("connection closed");
		this.ws.send(JSON.stringify(m));
	}
}
