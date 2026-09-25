import { DEAD_LETTER_WORDS, RETRY_EDGE_WORDS } from "../keywords";
import { makeFinding, named, type Rule } from "../rule";

/**
 * Without a dead-letter queue or retry path, a message that keeps failing either blocks the
 * queue (redelivered forever) or is dropped silently. Queues that are themselves DLQs are
 * skipped.
 */
export const queueNoDlqRule: Rule = {
  id: "queue-no-dlq",
  description: "A queue or stream with no dead-letter queue or retry path.",
  check: ({ graph }) =>
    graph.ofKind("queue").flatMap((queue) => {
      if (DEAD_LETTER_WORDS.test(queue.label)) return [];
      const handled = graph.touching(queue.id).some((edge) => {
        if (RETRY_EDGE_WORDS.test(edge.label)) return true;
        const other = graph.other(edge, queue.id);
        return (
          other?.kind === "queue" && other.id !== queue.id && DEAD_LETTER_WORDS.test(other.label)
        );
      });
      if (handled) return [];
      const noun = queue.props.mode === "stream" ? "stream" : "queue";
      return [
        makeFinding("queue-no-dlq", "warning", [queue.id], {
          title: `${named(queue.label)} has no dead-letter queue or retry path`,
          explanation:
            `A message that its consumer can't process (bad data, a bug, a dependency down) is ` +
            `either redelivered forever — blocking the ${noun} behind it — or dropped with ` +
            "nobody noticing.",
          suggestion:
            "Add a Queue labelled “DLQ” (or a retry topic) connected to this one, retry with " +
            "backoff a bounded number of times, then move the message there and alert on its " +
            "depth.",
        }),
      ];
    }),
};
