/**
 * Shared test helper for creating mock WhoopClient instances.
 *
 * Extracted from individual tool test files to reduce duplication.
 */

import { vi } from "vitest";
import type { WhoopClient } from "../../src/api/client.js";

/**
 * Create a mock WhoopClient whose `get()` method resolves with the given response.
 */
export function createMockClient(response: unknown): WhoopClient {
  return {
    get: vi.fn().mockResolvedValue(response),
  } as unknown as WhoopClient;
}
