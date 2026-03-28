/**
 * WebSocket connection manager for real-time sync
 */

import type { Server } from "node:http";
import type { SyncDelta } from "@shared-things/common";
import {
	parseClientMessage,
	type ServerMessage,
	serializeMessage,
} from "@shared-things/common";
import { WebSocket, WebSocketServer } from "ws";
import { type DB, getUserByApiKey } from "./db.js";

const HEARTBEAT_INTERVAL = 30_000;
const PONG_TIMEOUT = 10_000;

interface AuthenticatedSocket {
	ws: WebSocket;
	userId: string;
	userName: string;
	alive: boolean;
}

export class ConnectionManager {
	private wss: WebSocketServer;
	private connections = new Map<string, AuthenticatedSocket>();
	private heartbeatTimer: NodeJS.Timeout | null = null;

	constructor(
		server: Server,
		private db: DB,
	) {
		this.wss = new WebSocketServer({ server, path: "/ws" });
		this.wss.on("connection", (ws) => this.handleConnection(ws));
		this.startHeartbeat();
	}

	/** Notify all connected clients except the sender */
	notifyOthers(excludeUserId: string, delta: SyncDelta): void {
		const msg: ServerMessage = { type: "delta", payload: delta };
		const data = serializeMessage(msg);

		for (const [userId, conn] of this.connections) {
			if (userId !== excludeUserId && conn.ws.readyState === WebSocket.OPEN) {
				conn.ws.send(data);
			}
		}
	}

	/** Get list of connected user names */
	getConnectedUsers(): string[] {
		return Array.from(this.connections.values()).map((c) => c.userName);
	}

	close(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
		}
		this.wss.close();
	}

	private handleConnection(ws: WebSocket): void {
		let authenticated = false;

		// Client must authenticate within 5 seconds
		const authTimeout = setTimeout(() => {
			if (!authenticated) {
				this.send(ws, {
					type: "error",
					payload: { message: "Authentication timeout", code: "AUTH_TIMEOUT" },
				});
				ws.close();
			}
		}, 5000);

		ws.on("message", (raw) => {
			const msg = parseClientMessage(String(raw));
			if (!msg) return;

			if (msg.type === "auth") {
				clearTimeout(authTimeout);
				const user = getUserByApiKey(this.db, msg.payload.apiKey);

				if (!user) {
					this.send(ws, {
						type: "error",
						payload: { message: "Invalid API key", code: "UNAUTHORIZED" },
					});
					ws.close();
					return;
				}

				// Close existing connection for this user (single session)
				const existing = this.connections.get(user.id);
				if (existing) {
					existing.ws.close();
				}

				authenticated = true;
				this.connections.set(user.id, {
					ws,
					userId: user.id,
					userName: user.name,
					alive: true,
				});
				return;
			}

			if (msg.type === "pong") {
				const conn = this.findConnection(ws);
				if (conn) conn.alive = true;
				return;
			}
		});

		ws.on("close", () => {
			clearTimeout(authTimeout);
			for (const [userId, conn] of this.connections) {
				if (conn.ws === ws) {
					this.connections.delete(userId);
					break;
				}
			}
		});

		ws.on("error", () => {
			ws.close();
		});
	}

	private send(ws: WebSocket, msg: ServerMessage): void {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(serializeMessage(msg));
		}
	}

	private startHeartbeat(): void {
		this.heartbeatTimer = setInterval(() => {
			for (const [userId, conn] of this.connections) {
				if (!conn.alive) {
					conn.ws.close();
					this.connections.delete(userId);
					continue;
				}
				conn.alive = false;
				this.send(conn.ws, { type: "ping" });

				// If no pong within timeout, mark as dead
				setTimeout(() => {
					const current = this.connections.get(userId);
					if (current && !current.alive && current.ws === conn.ws) {
						current.ws.close();
						this.connections.delete(userId);
					}
				}, PONG_TIMEOUT);
			}
		}, HEARTBEAT_INTERVAL);
	}

	private findConnection(ws: WebSocket): AuthenticatedSocket | undefined {
		for (const conn of this.connections.values()) {
			if (conn.ws === ws) return conn;
		}
		return undefined;
	}
}
