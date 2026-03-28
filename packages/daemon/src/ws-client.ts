/**
 * WebSocket client with auto-reconnection
 */

import { EventEmitter } from "node:events";
import type { SyncDelta } from "@shared-things/common";
import {
	parseServerMessage,
	type ServerMessage,
	serializeMessage,
} from "@shared-things/common";
import WebSocket from "ws";
import { logDebug, logError, logInfo, logWarn } from "./logger.js";

const MIN_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30_000;

export class WsClient extends EventEmitter {
	private ws: WebSocket | null = null;
	private reconnectDelay = MIN_RECONNECT_DELAY;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private running = false;
	private hasConnectedBefore = false;

	constructor(
		private serverUrl: string,
		private apiKey: string,
	) {
		super();
	}

	start(): void {
		this.running = true;
		this.connect();
	}

	stop(): void {
		this.running = false;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
	}

	isConnected(): boolean {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	private connect(): void {
		if (!this.running) return;

		const wsUrl = this.serverUrl
			.replace(/^http:/, "ws:")
			.replace(/^https:/, "wss:");

		try {
			this.ws = new WebSocket(`${wsUrl}/ws`);
		} catch (err) {
			logError("WebSocket connect failed", err);
			this.scheduleReconnect();
			return;
		}

		this.ws.on("open", () => {
			logInfo("WebSocket connected");
			const isReconnect = this.hasConnectedBefore;
			this.hasConnectedBefore = true;
			this.reconnectDelay = MIN_RECONNECT_DELAY;

			this.ws?.send(
				serializeMessage({ type: "auth", payload: { apiKey: this.apiKey } }),
			);

			if (isReconnect) {
				this.emit("reconnected");
			}
		});

		this.ws.on("message", (raw) => {
			const msg = parseServerMessage(String(raw));
			if (!msg) return;

			this.handleMessage(msg);
		});

		this.ws.on("close", () => {
			logDebug("WebSocket closed");
			this.ws = null;
			if (this.running) {
				this.scheduleReconnect();
			}
		});

		this.ws.on("error", (err) => {
			logWarn(`WebSocket error: ${err.message}`);
			// close event will fire next and handle reconnect
		});
	}

	private handleMessage(msg: ServerMessage): void {
		switch (msg.type) {
			case "delta":
				logInfo(
					`Received delta: ${msg.payload.todos.upserted.length} upserted, ${msg.payload.todos.deleted.length} deleted`,
				);
				this.emit("delta", msg.payload as SyncDelta);
				break;

			case "ping":
				this.ws?.send(serializeMessage({ type: "pong" }));
				break;

			case "ack":
				logDebug(`Ack: ${msg.payload.requestId}`);
				break;

			case "error":
				logError(`Server error: ${msg.payload.message} (${msg.payload.code})`);
				if (msg.payload.code === "UNAUTHORIZED") {
					logError("Authentication failed. Check your API key.");
					this.running = false;
					this.ws?.close();
				}
				break;
		}
	}

	private scheduleReconnect(): void {
		if (!this.running) return;

		logDebug(`Reconnecting in ${this.reconnectDelay}ms...`);
		this.reconnectTimer = setTimeout(() => {
			this.connect();
		}, this.reconnectDelay);

		// Exponential backoff
		this.reconnectDelay = Math.min(
			this.reconnectDelay * 2,
			MAX_RECONNECT_DELAY,
		);
	}
}
