/**
 * Things 3 integration via AppleScript and URL Scheme
 */

import { execSync } from 'child_process';

export interface ThingsTodo {
  thingsId: string;
  title: string;
  notes: string;
  dueDate: string | null;
  tags: string[];
  status: 'open' | 'completed' | 'canceled';
  headingThingsId: string | null;
}

export interface ThingsHeading {
  thingsId: string;
  title: string;
}

/**
 * Execute AppleScript and return result
 */
function runAppleScript(script: string): string {
  try {
    return execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    }).trim();
  } catch (error) {
    throw new Error(`AppleScript failed: ${error}`);
  }
}

/**
 * Get all todos from a Things project
 */
export function getTodosFromProject(projectName: string): ThingsTodo[] {
  const script = `
    tell application "Things3"
      set todoList to {}
      set proj to project "${projectName}"
      repeat with t in to dos of proj
        set todoId to id of t
        set todoTitle to name of t
        set todoNotes to notes of t
        set todoStatus to status of t
        set todoDue to due date of t
        set todoTags to tag names of t

        -- Get heading if any
        set todoHeading to ""
        try
          set todoHeading to id of (get area of t)
        end try

        -- Format due date
        set dueDateStr to ""
        if todoDue is not missing value then
          set dueDateStr to (year of todoDue as string) & "-" & ¬
            (text -2 thru -1 of ("0" & (month of todoDue as integer) as string)) & "-" & ¬
            (text -2 thru -1 of ("0" & (day of todoDue) as string))
        end if

        -- Format status
        set statusStr to "open"
        if todoStatus is completed then
          set statusStr to "completed"
        else if todoStatus is canceled then
          set statusStr to "canceled"
        end if

        set end of todoList to todoId & "|||" & todoTitle & "|||" & todoNotes & "|||" & dueDateStr & "|||" & todoTags & "|||" & statusStr & "|||" & todoHeading
      end repeat

      set AppleScript's text item delimiters to "^^^"
      return todoList as string
    end tell
  `;

  const result = runAppleScript(script);
  if (!result) return [];

  return result.split('^^^').map(line => {
    const [thingsId, title, notes, dueDate, tags, status, headingThingsId] = line.split('|||');
    return {
      thingsId,
      title: title || '',
      notes: notes || '',
      dueDate: dueDate || null,
      tags: tags ? tags.split(', ').filter(Boolean) : [],
      status: (status as 'open' | 'completed' | 'canceled') || 'open',
      headingThingsId: headingThingsId || null,
    };
  });
}

/**
 * Get all headings from a Things project
 */
export function getHeadingsFromProject(projectName: string): ThingsHeading[] {
  // Note: Things AppleScript doesn't directly expose headings
  // We would need to use the Things database or work around this
  // For now, return empty - headings are optional
  return [];
}

/**
 * Create a new todo in Things via URL scheme
 */
export function createTodo(projectName: string, todo: {
  title: string;
  notes?: string;
  dueDate?: string;
  tags?: string[];
}): void {
  const params = new URLSearchParams();
  params.set('title', todo.title);
  if (todo.notes) params.set('notes', todo.notes);
  if (todo.dueDate) params.set('when', todo.dueDate);
  if (todo.tags?.length) params.set('tags', todo.tags.join(','));
  params.set('list', projectName);

  // URLSearchParams encodes spaces as '+', but Things expects '%20'
  const url = `things:///add?${params.toString().replace(/\+/g, '%20')}`;
  // -g flag opens in background without stealing focus
  execSync(`open -g "${url}"`);
}

/**
 * Update an existing todo via URL scheme
 */
export function updateTodo(authToken: string, thingsId: string, updates: {
  title?: string;
  notes?: string;
  dueDate?: string;
  completed?: boolean;
  canceled?: boolean;
}): void {
  const params = new URLSearchParams();
  params.set('auth-token', authToken);
  params.set('id', thingsId);

  if (updates.title !== undefined) params.set('title', updates.title);
  if (updates.notes !== undefined) params.set('notes', updates.notes);
  if (updates.dueDate !== undefined) params.set('when', updates.dueDate);
  if (updates.completed !== undefined) params.set('completed', updates.completed.toString());
  if (updates.canceled !== undefined) params.set('canceled', updates.canceled.toString());

  // URLSearchParams encodes spaces as '+', but Things expects '%20'
  const url = `things:///update?${params.toString().replace(/\+/g, '%20')}`;
  // -g flag opens in background without stealing focus
  execSync(`open -g "${url}"`);
}

/**
 * Get the Things URL scheme auth token (user must enable in Things settings)
 */
export function getAuthToken(): string | null {
  // The auth token needs to be configured by the user
  // It's available in Things > Settings > General > Things URLs
  // For now, we'll read it from config
  return null;
}

/**
 * Check if Things is running
 */
export function isThingsRunning(): boolean {
  try {
    const result = runAppleScript(`
      tell application "System Events"
        return (name of processes) contains "Things3"
      end tell
    `);
    return result === 'true';
  } catch {
    return false;
  }
}

/**
 * Check if a project exists in Things
 */
export function projectExists(projectName: string): boolean {
  try {
    const result = runAppleScript(`
      tell application "Things3"
        try
          set p to project "${projectName}"
          return true
        on error
          return false
        end try
      end tell
    `);
    return result === 'true';
  } catch {
    return false;
  }
}

/**
 * List all projects in Things
 */
export function listProjects(): string[] {
  const result = runAppleScript(`
    tell application "Things3"
      set projectNames to {}
      repeat with p in projects
        set end of projectNames to name of p
      end repeat
      set AppleScript's text item delimiters to "|||"
      return projectNames as string
    end tell
  `);

  if (!result) return [];
  return result.split('|||').filter(Boolean);
}
