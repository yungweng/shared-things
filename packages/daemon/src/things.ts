/**
 * Things 3 integration via AppleScript and URL Scheme
 */

import { execSync } from "node:child_process";
import { logWarn } from "./logger.js";

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
const MAX_URL_LENGTH = 2000;

/**
 * Execute AppleScript and return result
 */
function runAppleScript(script: string): string {
	try {
		return execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
			encoding: "utf-8",
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
		const decodedTitle = unescapeField(title);
		const decodedNotes = unescapeField(notes);
		const decodedTags = unescapeField(tags);
		return {
			thingsId,
			title: decodedTitle || "",
			notes: decodedNotes || "",
			dueDate: dueDate || null,
			tags: decodedTags ? decodedTags.split(", ").filter(Boolean) : [],
			status: (status as "open" | "completed" | "canceled") || "open",
		};
	});
}

function unescapeField(value: string): string {
	if (!value) return "";
	return value.replaceAll(PIPE_TOKEN, "|||").replaceAll(CARET_TOKEN, "^^^");
}

/**
 * Create a new todo in Things via URL scheme
 */
export function createTodo(
	projectName: string,
	todo: {
		title: string;
		notes?: string;
		dueDate?: string;
		tags?: string[];
	},
): void {
	const params = new URLSearchParams();
	params.set("title", todo.title);
	if (todo.notes) params.set("notes", todo.notes);
	if (todo.dueDate) params.set("when", todo.dueDate);
	if (todo.tags?.length) params.set("tags", todo.tags.join(","));
	params.set("list", projectName);

	// URLSearchParams encodes spaces as '+', but Things expects '%20'
	let url = `things:///add?${params.toString().replace(/\+/g, "%20")}`;
	if (url.length > MAX_URL_LENGTH && todo.notes) {
		const originalNotes = todo.notes;
		let truncated = originalNotes;
		while (truncated.length > 0 && url.length > MAX_URL_LENGTH) {
			truncated = truncated.slice(0, Math.max(0, truncated.length - 200));
			params.set("notes", truncated);
			url = `things:///add?${params.toString().replace(/\+/g, "%20")}`;
		}
		logWarn(
			`Create URL exceeded ${MAX_URL_LENGTH} chars; notes truncated from ${originalNotes.length} to ${truncated.length}`,
		);
	}
	// -g flag opens in background without stealing focus
	execSync(`open -g "${url}"`);
}

/**
 * Update an existing todo via URL scheme
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

	// URLSearchParams encodes spaces as '+', but Things expects '%20'
	const url = `things:///update?${params.toString().replace(/\+/g, "%20")}`;
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
		return result === "true";
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
		return result === "true";
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
	return result.split("|||").filter(Boolean);
}
