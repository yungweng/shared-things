/**
 * shared-things server
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { initDatabase } from './db.js';
import { authMiddleware } from './auth.js';
import { registerRoutes } from './routes.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  // Initialize database
  const db = initDatabase();

  // Create Fastify instance
  const app = Fastify({
    logger: true,
  });

  // Register CORS
  await app.register(cors, {
    origin: true,
  });

  // Add auth middleware
  app.addHook('preHandler', authMiddleware(db));

  // Register routes
  registerRoutes(app, db);

  // Start server
  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`Server running at http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
