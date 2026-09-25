import { reviewStreamEventSchema, type ReviewStreamEvent } from "@whiteboard/graph";

/**
 * Reads a server-sent event stream (`data: <json>` blocks separated by blank lines) and
 * yields each event validated against the review stream schema. Comment lines (the server's
 * keep-alive pings) are skipped; an event that fails validation ends the stream with an error.
 */
export async function* readReviewEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<ReviewStreamEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value !== undefined)
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseBlock(block);
        if (event) yield event;
        boundary = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
    const last = parseBlock(buffer);
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}

function parseBlock(block: string): ReviewStreamEvent | null {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!data) return null;
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    throw new Error("Malformed event from the server");
  }
  const parsed = reviewStreamEventSchema.safeParse(json);
  if (!parsed.success) throw new Error("Unexpected event from the server");
  return parsed.data;
}
