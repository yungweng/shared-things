/**
 * Authentication middleware
 */

import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';
import { getUserByApiKey, type DB } from './db.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: {
      id: string;
      name: string;
    };
  }
}

export function authMiddleware(db: DB) {
  return (
    request: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction
  ) => {
    // Skip auth for health check
    if (request.url === '/health') {
      return done();
    }

    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      reply.code(401).send({ error: 'Missing or invalid authorization header', code: 'UNAUTHORIZED' });
      return;
    }

    const apiKey = authHeader.slice(7);
    const user = getUserByApiKey(db, apiKey);

    if (!user) {
      reply.code(401).send({ error: 'Invalid API key', code: 'UNAUTHORIZED' });
      return;
    }

    request.user = user;
    done();
  };
}
