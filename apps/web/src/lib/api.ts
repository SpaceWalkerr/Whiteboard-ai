import { healthResponseSchema, type HealthResponse } from "@whiteboard/shared/schemas";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Calls the server's liveness endpoint and validates the response shape. */
export async function fetchHealth(apiUrl: string, signal?: AbortSignal): Promise<HealthResponse> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/healthz`, signal ? { signal } : {});
  } catch {
    // Network failures and CORS rejections are indistinguishable from the browser's side.
    throw new ApiError("Could not reach the server");
  }
  if (!response.ok) {
    throw new ApiError(`Server responded with ${response.status}`, response.status);
  }
  const parsed = healthResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new ApiError("Unexpected response from the server");
  return parsed.data;
}
