/**
 * Things 3 integration via AppleScript and URL Scheme (v3)
 *
 * Key v3 changes:
 * - createTodo uses AppleScript (returns ID atomically, no polling needed)
 * - deleteTodo moves to Papierkorb via AppleScript
 */

import { execSync } from "node:child_process";

export interface ThingsTodo {
	thingsId: string;
	title: string;
	notes: string;
	dueDate: string | null;
	tags: string[];
	status: "open" | "completed" | "canceled";
}

const PIPE_TOKEN = "{{PIPE}}";
const CARET_TOKEN = "{{CARET}}";

function runAppleScript(script: string): string {
	try {
		return execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
			encoding: "utf-8",
			maxBuffer: 10 * 1024 * 1024,
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
    on replaceText(findText, replaceText, theText)
      set AppleScript's text item delimiters to findText
      set theItems to every text item of theText
      set AppleScript's text item delimiters to replaceText
      set theText to theItems as string
      set AppleScript's text item delimiters to ""
      return theText
    end replaceText

    on escapeText(t)
      if t is missing value then return ""
      set t to my replaceText("|||", "${PIPE_TOKEN}", t as string)
      set t to my replaceText("^^^", "${CARET_TOKEN}", t as string)
      return t
    end escapeText

    tell application "Things3"
      set todoList to {}
      set proj to project "${projectName}"
      repeat with t in to dos of proj
        set todoId to id of t
        set todoTitle to my escapeText(name of t)
        set todoNotes to my escapeText(notes of t)
        set todoStatus to status of t
        set todoDue to due date of t
        set AppleScript's text item delimiters to ", "
        set todoTags to my escapeText((tag names of t) as string)
        set AppleScript's text item delimiters to ""

        set dueDateStr to ""
        if todoDue is not missing value then
          set dueDateStr to (year of todoDue as string) & "-" & ¬
            (text -2 thru -1 of ("0" & (month of todoDue as integer) as string)) & "-" & ¬
            (text -2 thru -1 of ("0" & (day of todoDue) as string))
        end if

        set statusStr to "open"
        if todoStatus is completed then
          set statusStr to "completed"
        else if todoStatus is canceled then
          set statusStr to "canceled"
        end if

        set end of todoList to todoId & "|||" & todoTitle & "|||" & todoNotes & "|||" & dueDateStr & "|||" & todoTags & "|||" & statusStr
      end repeat

      set AppleScript's text item delimiters to "^^^"
      return todoList as string
    end tell
  `;

	const result = runAppleScript(script);
	if (!result) return [];

	return result.split("^^^").map((line) => {
		const [thingsId, title, notes, dueDate, tags, status] = line.split("|||");
		return {
			thingsId,
			title: unescapeField(title) || "",
			notes: unescapeField(notes) || "",
			dueDate: dueDate || null,
			tags: unescapeField(tags)
				? unescapeField(tags).split(", ").filter(Boolean)
				: [],
			status: (status as ThingsTodo["status"]) || "open",
		};
	});
}

function unescapeField(value: string): string {
	if (!value) return "";
	return value.replaceAll(PIPE_TOKEN, "|||").replaceAll(CARET_TOKEN, "^^^");
}

/**
 * Create a new todo via AppleScript (returns the Things ID atomically)
 *
 * This is the key v3 improvement: no more URL Scheme + findNewTodo polling.
 */
export function createTodo(
	projectName: string,
	todo: {
		title: string;
		notes?: string;
		dueDate?: string;
		tags?: string[];
	},
): string {
	// Escape for AppleScript string
	const escTitle = todo.title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const escNotes = (todo.notes || "")
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"');

	let props = `name:"${escTitle}", notes:"${escNotes}"`;

	if (todo.tags?.length) {
		const escTags = todo.tags
			.map((t) => t.replace(/\\/g, "\\\\").replace(/"/g, '\\"'))
			.join(",");
		props += `, tag names:"${escTags}"`;
	}

	let dateSetup = "";
	if (todo.dueDate) {
		// Parse YYYY-MM-DD and set due date
		dateSetup = `
      set dueStr to "${todo.dueDate}"
      set yr to text 1 thru 4 of dueStr as integer
      set mo to text 6 thru 7 of dueStr as integer
      set dy to text 9 thru 10 of dueStr as integer
      set dueD to current date
      set year of dueD to yr
      set month of dueD to mo
      set day of dueD to dy
      set due date of newTodo to dueD
    `;
	}

	const script = `
    tell application "Things3"
      set newTodo to make new to do with properties {${props}} at beginning of project "${projectName}"
      ${dateSetup}
      return id of newTodo
    end tell
  `;

	return runAppleScript(script);
}

/**
 * Update an existing todo via URL Scheme
 */
export function updateTodo(
	authToken: string,
	thingsId: string,
	updates: {
		title?: string;
		notes?: string;
		dueDate?: string;
		completed?: boolean;
		canceled?: boolean;
	},
): void {
	const params = new URLSearchParams();
	params.set("auth-token", authToken);
	params.set("id", thingsId);

	if (updates.title !== undefined) params.set("title", updates.title);
	if (updates.notes !== undefined) params.set("notes", updates.notes);
	if (updates.dueDate !== undefined) params.set("when", updates.dueDate);
	if (updates.completed !== undefined)
		params.set("completed", updates.completed.toString());
	if (updates.canceled !== undefined)
		params.set("canceled", updates.canceled.toString());

	const url = `things:///update?${params.toString().replace(/\+/g, "%20")}`;
	execSync(`open -g "${url}"`);
}

/**
 * Delete a todo by moving it to Papierkorb (Trash) via AppleScript
 *
 * New in v3 — previously deletion was not possible.
 */
export function deleteTodo(thingsId: string): void {
	// List 9 is always Trash/Papierkorb regardless of locale
	const script = `
    tell application "Things3"
      set t to to do id "${thingsId}"
      move t to list 9
    end tell
  `;
	runAppleScript(script);
}

export function isThingsRunning(): boolean {
	try {
		const result = runAppleScript(`
      tell application "System Events"
        return (name of processes) contains "Things3"
      end tell
    `);
		return result === "true";
	} catch {
		return false;
	}
}

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
		return result === "true";
	} catch {
		return false;
	}
}

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
	return result.split("|||").filter(Boolean);
}
