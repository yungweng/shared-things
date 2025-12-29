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
 * Create a new todo in Things via AppleScript (doesn't activate Things)
 */
export function createTodo(projectName: string, todo: {
  title: string;
  notes?: string;
  dueDate?: string;
  tags?: string[];
}): void {
  const escapedTitle = todo.title.replace(/"/g, '\\"');
  const escapedNotes = (todo.notes || '').replace(/"/g, '\\"');

  let dueDatePart = '';
  if (todo.dueDate) {
    // Parse YYYY-MM-DD format
    const [year, month, day] = todo.dueDate.split('-').map(Number);
    dueDatePart = `set due date of newTodo to date "${month}/${day}/${year}"`;
  }

  const script = `
    tell application "Things3"
      set newTodo to make new to do ¬
        with properties {name:"${escapedTitle}", notes:"${escapedNotes}"} ¬
        at beginning of project "${projectName}"
      ${dueDatePart}
    end tell
  `;

  runAppleScript(script);
}

/**
 * Update an existing todo via AppleScript (doesn't activate Things)
 */
export function updateTodo(_authToken: string, thingsId: string, updates: {
  title?: string;
  notes?: string;
  dueDate?: string;
  completed?: boolean;
  canceled?: boolean;
}): void {
  const setParts: string[] = [];

  if (updates.title !== undefined) {
    const escaped = updates.title.replace(/"/g, '\\"');
    setParts.push(`set name of t to "${escaped}"`);
  }
  if (updates.notes !== undefined) {
    const escaped = updates.notes.replace(/"/g, '\\"');
    setParts.push(`set notes of t to "${escaped}"`);
  }
  if (updates.dueDate !== undefined) {
    if (updates.dueDate) {
      const [year, month, day] = updates.dueDate.split('-').map(Number);
      setParts.push(`set due date of t to date "${month}/${day}/${year}"`);
    } else {
      setParts.push(`set due date of t to missing value`);
    }
  }
  if (updates.completed === true) {
    setParts.push(`set status of t to completed`);
  }
  if (updates.canceled === true) {
    setParts.push(`set status of t to canceled`);
  }

  if (setParts.length === 0) return;

  const script = `
    tell application "Things3"
      set t to to do id "${thingsId}"
      ${setParts.join('\n      ')}
    end tell
  `;

  runAppleScript(script);
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
