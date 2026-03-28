/**
 * shared-things server (v3)
 */

import * as http from "node:http";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { authMiddleware } from "./auth.js";
import { initDatabase } from "./db.js";
import { registerRoutes } from "./routes.js";
import { ConnectionManager } from "./websocket.js";

export interface ServerOptions {
	port?: number;
	host?: string;
	logger?: boolean;
}

export async function createServer(options: ServerOptions = {}): Promise<{
	app: Awaited<ReturnType<typeof Fastify>>;
	wsManager: ConnectionManager;
}> {
	const { port = 3334, host = "0.0.0.0", logger = true } = options;

	const db = initDatabase();

	const app = Fastify({
		logger,
		serverFactory: (handler) => {
			const server = http.createServer(handler);
			return server;
		},
	});

	await app.register(cors, { origin: true });
	app.addHook("preHandler", authMiddleware(db));

	// WebSocket manager uses the underlying HTTP server
	const wsManager = new ConnectionManager(app.server, db);

	registerRoutes(app, db, wsManager);

	await app.listen({ port, host });

	return { app, wsManager };
}
