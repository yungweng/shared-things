/**
 * API routes
 */

import type { FastifyInstance } from 'fastify';
import type { ProjectState, PushRequest, PushResponse, Conflict } from '@shared-things/common';
import {
  type DB,
  getAllHeadings,
  getAllTodos,
  getHeadingsSince,
  getTodosSince,
  getDeletedSince,
  upsertHeading,
  upsertTodo,
  deleteHeading,
  deleteTodo,
} from './db.js';

export function registerRoutes(app: FastifyInstance, db: DB) {
  // Health check (no auth)
  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Get full project state
  app.get('/state', async (request): Promise<ProjectState> => {
    const headings = getAllHeadings(db);
    const todos = getAllTodos(db);

    return {
      headings: headings as ProjectState['headings'],
      todos: todos as ProjectState['todos'],
      syncedAt: new Date().toISOString(),
    };
  });

  // Get changes since timestamp
  app.get<{ Querystring: { since: string } }>('/delta', async (request) => {
    const { since } = request.query;

    if (!since) {
      return { error: 'Missing "since" query parameter', code: 'BAD_REQUEST' };
    }

    const headings = getHeadingsSince(db, since);
    const todos = getTodosSince(db, since);
    const deleted = getDeletedSince(db, since);

    return {
      headings: {
        upserted: headings,
        deleted: deleted.headings,
      },
      todos: {
        upserted: todos,
        deleted: deleted.todos,
      },
      syncedAt: new Date().toISOString(),
    };
  });

  // Push changes
  app.post<{ Body: PushRequest }>('/push', async (request): Promise<PushResponse> => {
    const { headings, todos } = request.body;
    const userId = request.user.id;
    const conflicts: Conflict[] = [];

    // Process heading deletions first
    for (const thingsId of headings.deleted) {
      deleteHeading(db, thingsId, userId);
    }

    // Process heading upserts
    for (const heading of headings.upserted) {
      upsertHeading(db, heading.thingsId, heading.title, heading.position, userId);
    }

    // Process todo deletions
    for (const thingsId of todos.deleted) {
      deleteTodo(db, thingsId, userId);
    }

    // Process todo upserts
    for (const todo of todos.upserted) {
      // Find heading ID if headingThingsId is provided
      let headingId: string | null = null;
      if (todo.headingId) {
        // todo.headingId here is actually thingsId of the heading
        const headingRow = db.prepare(`SELECT id FROM headings WHERE things_id = ?`).get(todo.headingId) as { id: string } | undefined;
        headingId = headingRow?.id || null;
      }

      upsertTodo(db, todo.thingsId, {
        title: todo.title,
        notes: todo.notes,
        dueDate: todo.dueDate,
        tags: todo.tags,
        status: todo.status,
        headingId,
        position: todo.position,
      }, userId);
    }

    // Return current state
    const currentHeadings = getAllHeadings(db);
    const currentTodos = getAllTodos(db);

    return {
      state: {
        headings: currentHeadings as ProjectState['headings'],
        todos: currentTodos as ProjectState['todos'],
        syncedAt: new Date().toISOString(),
      },
      conflicts,
    };
  });
}
