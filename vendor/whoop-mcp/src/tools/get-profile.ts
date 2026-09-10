/**
 * Tool: get_profile
 *
 * Fetches the authenticated user's basic profile (name and email).
 */

import type { WhoopClient } from "../api/client.js";
import type { UserProfile } from "../api/types.js";
import { ENDPOINT_USER_PROFILE } from "../api/endpoints.js";

/**
 * Get the authenticated user's basic profile.
 *
 * @param client - Authenticated WHOOP API client
 * @returns User profile with user_id, email, first_name, last_name
 */
export async function getProfile(client: WhoopClient): Promise<UserProfile> {
  return client.get<UserProfile>(ENDPOINT_USER_PROFILE);
}
