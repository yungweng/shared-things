/**
 * API client for the shared-things server
 */

import type {
	ProjectState,
	PushRequest,
	PushResponse,
	SyncDelta,
} from "@shared-things/common";

export class ApiClient {
	private static readonly TIMEOUT_MS = 30_000;

	constructor(
		private serverUrl: string,
		private apiKey: string,
	) {}

	private async request<T>(
		path: string,
		options: RequestInit = {},
	): Promise<T> {
		const url = `${this.serverUrl}${path}`;
		const headers = {
			Authorization: `Bearer ${this.apiKey}`,
			"Content-Type": "application/json",
			...options.headers,
		};

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), ApiClient.TIMEOUT_MS);

		let response: Response;
		try {
			response = await fetch(url, {
				...options,
				headers,
				signal: controller.signal,
			});
		} catch (error) {
			if ((error as { name?: string }).name === "AbortError") {
				throw new Error(`API timeout after ${ApiClient.TIMEOUT_MS}ms`);
			}
			throw error;
		} finally {
			clearTimeout(timeout);
		}

		if (!response.ok) {
			const error = await response
				.json()
				.catch(() => ({ error: "Unknown error" }));
			throw new Error(`API error: ${error.error || response.statusText}`);
		}

		return response.json() as Promise<T>;
	}

	async getState(): Promise<ProjectState> {
		return this.request<ProjectState>("/state");
	}

	async getDelta(since: string): Promise<SyncDelta> {
		return this.request<SyncDelta>(`/delta?since=${encodeURIComponent(since)}`);
	}

	async push(request: PushRequest): Promise<PushResponse> {
		return this.request<PushResponse>("/push", {
			method: "POST",
			body: JSON.stringify(request),
		});
	}

	async health(): Promise<{ status: string; timestamp: string }> {
		return this.request<{ status: string; timestamp: string }>("/health");
	}

	async reset(): Promise<{
		success: boolean;
		deleted: { todos: number };
	}> {
		return this.request("/reset", { method: "DELETE" });
	}
}
