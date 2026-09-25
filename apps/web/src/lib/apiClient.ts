import type { z } from "zod";
import { errorResponseSchema } from "@whiteboard/shared/api";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export interface ApiClient {
  request<S extends z.ZodType>(
    path: string,
    options: { method?: string; body?: unknown; schema: S; shareToken?: string | undefined },
  ): Promise<z.output<S>>;
  /** For responses without a body (204). */
  send(path: string, options: { method: string; body?: unknown }): Promise<void>;
  /** Uploads a binary body (e.g. a PNG thumbnail); expects no response body. */
  upload(
    path: string,
    options: { method: string; body: Blob; shareToken?: string | undefined },
  ): Promise<void>;
}

/**
 * Calls apps/server with the current Supabase access token (refreshed by supabase-js as
 * needed) and validates every response with its zod schema.
 */
export function createApiClient(
  apiUrl: string,
  getAccessToken: () => Promise<string | null>,
): ApiClient {
  const call = async (path: string, method: string, body: unknown, shareToken?: string) => {
    const token = await getAccessToken();
    const binary = body instanceof Blob;
    let response: Response;
    try {
      response = await fetch(`${apiUrl}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined
            ? { "content-type": binary ? body.type : "application/json" }
            : {}),
          ...(shareToken ? { "x-share-token": shareToken } : {}),
        },
        ...(body !== undefined ? { body: binary ? body : JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ApiRequestError(0, "NETWORK", "Could not reach the server. Check your connection.");
    }
    if (!response.ok) {
      const parsed = errorResponseSchema.safeParse(await response.json().catch(() => null));
      throw new ApiRequestError(
        response.status,
        parsed.success ? parsed.data.error.code : "HTTP_ERROR",
        parsed.success ? parsed.data.error.message : `Request failed (${response.status})`,
      );
    }
    return response;
  };
  return {
    async request(path, { method = "GET", body, schema, shareToken }) {
      const response = await call(path, method, body, shareToken);
      const parsed = schema.safeParse(await response.json());
      if (!parsed.success)
        throw new ApiRequestError(
          response.status,
          "BAD_RESPONSE",
          "Unexpected response from the server.",
        );
      return parsed.data;
    },
    async send(path, { method, body }) {
      await call(path, method, body);
    },
    async upload(path, { method, body, shareToken }) {
      await call(path, method, body, shareToken);
    },
  };
}
