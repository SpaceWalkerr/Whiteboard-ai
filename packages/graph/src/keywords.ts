/**
 * Word lists the rules use to read intent from labels. Rules only act on a clear signal, so an
 * unlabeled board gets fewer findings rather than noisy guesses.
 */

/** Labels that say a path serves reads. */
export const READ_WORDS =
  /\b(?:read|reads|reading|get|gets|fetch|fetches|query|queries|search|searches|browse|view|views|list|lists|feed|feeds|timeline|lookup|lookups|load|loads)\b/i;

/** A queue that is itself a dead-letter / retry / parking queue. */
export const DEAD_LETTER_WORDS =
  /\b(?:dlq|dlx|dead[\s-]?letters?|dead|retry|retries|retrying|parking|parked|poison)\b/i;

/** An edge label describing a retry path ("retry", "requeue", "redrive", "to DLQ"). */
export const RETRY_EDGE_WORDS =
  /\b(?:dlq|dlx|dead[\s-]?letters?|retry|retries|requeue|re-queue|redrive|redelivery|backoff)\b/i;

/** Components that serve static files or media. */
export const STATIC_CONTENT_WORDS =
  /\b(?:static|assets?|media|images?|videos?|files?|uploads?|blobs?|thumbnails?)\b/i;
