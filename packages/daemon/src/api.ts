/**
 * API client for the shared-things server
 */

import type { ProjectState, PushRequest, PushResponse, SyncDelta } from '@shared-things/common';

export class ApiClient {
  constructor(
    private serverUrl: string,
    private apiKey: string
  ) {}

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.serverUrl}${path}`;
    const headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    const response = await fetch(url, { ...options, headers });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(`API error: ${error.error || response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Get full project state
   */
  async getState(): Promise<ProjectState> {
    return this.request<ProjectState>('/state');
  }

  /**
   * Get changes since timestamp
   */
  async getDelta(since: string): Promise<SyncDelta> {
    return this.request<SyncDelta>(`/delta?since=${encodeURIComponent(since)}`);
  }

  /**
   * Push local changes
   */
  async push(request: PushRequest): Promise<PushResponse> {
    return this.request<PushResponse>('/push', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  /**
   * Health check
   */
  async health(): Promise<{ status: string; timestamp: string }> {
    return this.request<{ status: string; timestamp: string }>('/health');
  }

  /**
   * Reset all user data on server
   */
  async reset(): Promise<{ success: boolean; deleted: { todos: number; headings: number } }> {
    return this.request<{ success: boolean; deleted: { todos: number; headings: number } }>('/reset', {
      method: 'DELETE',
    });
  }
}
