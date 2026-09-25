import { z } from "zod";
import { interviewQuestionSchema, type InterviewQuestion } from "@whiteboard/shared/interview";

/**
 * The built-in question bank. Server-only on purpose: hints must never ship in the public web
 * bundle, where a candidate could read them. Interviewers fetch the bank over REST; a copy of
 * the chosen question is stored with each interview.
 */
const QUESTIONS: InterviewQuestion[] = [
  {
    id: "url-shortener",
    title: "URL shortener",
    prompt:
      "Design a service like bit.ly that turns long URLs into short links and redirects visitors to the original URL.",
    difficulty: "easy",
    tags: ["read-heavy", "caching", "id-generation"],
    requirements: {
      functional: [
        "Create a short link for a long URL (optionally with a custom alias)",
        "Redirect a short link to its long URL",
        "Links can expire",
        "Basic click analytics per link",
      ],
      nonFunctional: [
        "100M new links per month, 100:1 read to write ratio",
        "Redirect latency under 50 ms at p99",
        "Short codes must not be guessable in sequence",
        "Highly available redirects (99.99%)",
      ],
    },
    hints: [
      "Estimate storage: how many links over 5 years, and how long must a code be?",
      "How would you generate unique codes across many servers without a single counter bottleneck?",
      "Redirects dominate traffic — where would you cache, and what is the hit rate likely to be?",
      "Analytics writes shouldn't slow redirects down. How could you record clicks asynchronously?",
    ],
  },
  {
    id: "chat-app",
    title: "Chat application",
    prompt: "Design a messaging app like WhatsApp or Slack supporting one-to-one and group chats.",
    difficulty: "hard",
    tags: ["realtime", "websockets", "fan-out"],
    requirements: {
      functional: [
        "One-to-one and group messages (groups up to 500 members)",
        "Online/offline presence and last seen",
        "Delivered and read receipts",
        "Message history synced across a user's devices",
      ],
      nonFunctional: [
        "50M daily active users",
        "Messages delivered in under 200 ms when both users are online",
        "No message is ever lost; ordering preserved within a conversation",
      ],
    },
    hints: [
      "How does the server push a message to a recipient's device? Compare polling and persistent connections.",
      "Users are connected to different gateway servers. How does a message find the right one?",
      "What happens to a message when the recipient is offline?",
      "How do you order messages within a conversation when senders' clocks disagree?",
    ],
  },
  {
    id: "news-feed",
    title: "News feed",
    prompt:
      "Design the home feed of a social network like Twitter/X or Facebook, showing posts from the people a user follows.",
    difficulty: "hard",
    tags: ["fan-out", "caching", "ranking"],
    requirements: {
      functional: [
        "Publish a post (text and images)",
        "View a feed of posts from followed accounts, newest or ranked",
        "Follow and unfollow accounts",
      ],
      nonFunctional: [
        "300M daily active users, each loading the feed ~10 times a day",
        "Feed loads in under 300 ms at p99",
        "A new post appears in followers' feeds within a few seconds",
      ],
    },
    hints: [
      "Compare fan-out on write (push) with fan-out on read (pull). What does each cost?",
      "What happens when an account with 50M followers posts?",
      "Where do images live, and how are they served to users around the world?",
      "What exactly would you cache for a user's feed, and how is it invalidated?",
    ],
  },
  {
    id: "rate-limiter",
    title: "Distributed rate limiter",
    prompt:
      "Design a rate limiter that an API gateway uses to limit how many requests each client can make.",
    difficulty: "medium",
    tags: ["algorithms", "redis", "consistency"],
    requirements: {
      functional: [
        "Limit requests per API key and per IP (e.g. 100 per minute)",
        "Different limits for different endpoints and plans",
        "Tell clients their remaining allowance and when to retry",
      ],
      nonFunctional: [
        "Adds under 5 ms of latency to each request",
        "Works across a fleet of 50 gateway servers",
        "If the limiter fails, the API keeps working",
      ],
    },
    hints: [
      "Compare fixed window, sliding window and token bucket. Which handles bursts at window edges?",
      "Where is the counter stored so that all gateway servers agree?",
      "How do you make increment-and-check atomic?",
      "Should requests be allowed or blocked when the counter store is unreachable?",
    ],
  },
  {
    id: "ride-sharing",
    title: "Ride sharing",
    prompt:
      "Design a ride-hailing service like Uber or Grab that matches riders with nearby drivers.",
    difficulty: "hard",
    tags: ["geospatial", "realtime", "matching"],
    requirements: {
      functional: [
        "Riders request a ride and see an ETA and price",
        "Match a rider with a nearby available driver",
        "Live location of the driver during the trip",
        "Trip history and payment",
      ],
      nonFunctional: [
        "1M drivers sending their location every 4 seconds",
        "Match within a few seconds of a request",
        "A driver is never assigned to two riders at once",
      ],
    },
    hints: [
      "250k location updates per second: where do they go, and do they all need to be stored forever?",
      "How do you find drivers near a point quickly? Consider geohashes or a grid.",
      "Two requests pick the same driver at the same moment. How do you prevent a double assignment?",
      "Which parts need strong consistency, and which can be eventually consistent?",
    ],
  },
  {
    id: "file-storage",
    title: "File storage and sync",
    prompt:
      "Design a file storage and sync service like Dropbox or Google Drive that keeps files in sync across a user's devices.",
    difficulty: "hard",
    tags: ["storage", "sync", "deduplication"],
    requirements: {
      functional: [
        "Upload, download and delete files up to 10 GB",
        "Automatic sync across devices",
        "Share files and folders with other users",
        "File version history",
      ],
      nonFunctional: [
        "500M users, 10 PB of data",
        "Resumable uploads over unreliable networks",
        "Files are never lost or corrupted",
      ],
    },
    hints: [
      "Would you upload a 10 GB file in one request? Think about chunks.",
      "How can chunking save storage and bandwidth when a small part of a large file changes?",
      "Separate file metadata from file content — where does each live?",
      "How does a device learn that a file changed elsewhere?",
    ],
  },
  {
    id: "notification-system",
    title: "Notification system",
    prompt:
      "Design a system that sends notifications to users by push, email and SMS on behalf of many internal services.",
    difficulty: "medium",
    tags: ["queues", "retries", "third-party"],
    requirements: {
      functional: [
        "Internal services send notifications through one API",
        "Channels: mobile push, email and SMS",
        "Per-user preferences and quiet hours",
        "Templates and scheduled notifications",
      ],
      nonFunctional: [
        "Up to 10M notifications per minute during campaigns",
        "Critical notifications (e.g. one-time passwords) delivered within seconds",
        "No duplicate notifications to a user",
      ],
    },
    hints: [
      "Should the API call the SMS provider synchronously? What if the provider is slow?",
      "How do you keep a marketing campaign from delaying one-time passwords?",
      "A provider call times out: do you retry? How do you avoid sending twice?",
      "Where do messages go after repeated failures?",
    ],
  },
  {
    id: "web-crawler",
    title: "Web crawler",
    prompt: "Design a web crawler that downloads billions of pages for a search engine.",
    difficulty: "medium",
    tags: ["distributed", "politeness", "deduplication"],
    requirements: {
      functional: [
        "Start from seed URLs and follow links",
        "Store page content for indexing",
        "Recrawl pages periodically based on how often they change",
      ],
      nonFunctional: [
        "1B pages per month",
        "Politeness: respect robots.txt and never overload one site",
        "Avoid crawling the same page or duplicate content twice",
      ],
    },
    hints: [
      "What data structure holds the URLs still to crawl, and how is it split across workers?",
      "How do you ensure at most one request per second to any single host?",
      "How do you check quickly whether a URL has been seen among billions?",
      "Different URLs can serve identical content. How would you detect that?",
    ],
  },
  {
    id: "search-autocomplete",
    title: "Search autocomplete",
    prompt: "Design the type-ahead suggestions shown as a user types into a search box.",
    difficulty: "medium",
    tags: ["trie", "caching", "latency"],
    requirements: {
      functional: [
        "Return the top 10 suggestions for a prefix",
        "Rank suggestions by popularity",
        "Update popularity from recent searches",
      ],
      nonFunctional: [
        "Suggestions within 100 ms of each keystroke",
        "100k queries per second at peak",
        "Popularity may lag reality by up to an hour",
      ],
    },
    hints: [
      "Which data structure answers 'top suggestions for this prefix' quickly?",
      "Could the top results for each prefix be precomputed?",
      "How often does the index need rebuilding, and can it happen offline?",
      "What can the browser or a CDN cache to reduce load?",
    ],
  },
  {
    id: "distributed-cache",
    title: "Distributed cache",
    prompt: "Design a distributed in-memory key-value cache like Memcached or Redis Cluster.",
    difficulty: "hard",
    tags: ["partitioning", "replication", "eviction"],
    requirements: {
      functional: [
        "get, set and delete with an optional time-to-live",
        "Capacity grows by adding nodes",
        "Evict entries when memory is full",
      ],
      nonFunctional: [
        "Sub-millisecond reads",
        "1M operations per second",
        "Losing a node loses only a small share of the cache",
      ],
    },
    hints: [
      "How are keys assigned to nodes so that adding a node moves as few keys as possible?",
      "Which eviction policy fits, and how is it implemented in O(1)?",
      "One key is extremely popular. What happens to its node?",
      "Do you need replicas? What consistency do readers get?",
    ],
  },
  {
    id: "video-streaming",
    title: "Video streaming",
    prompt: "Design a video platform like YouTube where users upload videos and others watch them.",
    difficulty: "hard",
    tags: ["cdn", "transcoding", "storage"],
    requirements: {
      functional: [
        "Upload videos up to several GB",
        "Stream videos on phones, laptops and TVs",
        "View counts, likes and comments",
      ],
      nonFunctional: [
        "1B views per day worldwide",
        "Playback starts within 2 seconds; quality adapts to bandwidth",
        "Uploaded videos are never lost",
      ],
    },
    hints: [
      "What has to happen to a video between upload and being playable on every device?",
      "How does the player switch quality as the network changes?",
      "Where are video bytes served from for a viewer on another continent?",
      "How do you count billions of views without a hot row in the database?",
    ],
  },
  {
    id: "payment-system",
    title: "Payment system",
    prompt:
      "Design the payment backend of an e-commerce company that charges customers through external payment providers.",
    difficulty: "hard",
    tags: ["consistency", "idempotency", "ledger"],
    requirements: {
      functional: [
        "Charge a customer for an order",
        "Refunds",
        "Pay out to sellers",
        "Reconcile with the payment provider's records",
      ],
      nonFunctional: [
        "A customer is never charged twice for one order",
        "Every movement of money is auditable",
        "1,000 payments per second at peak",
      ],
    },
    hints: [
      "The provider call times out. Did the charge happen? How do you retry safely?",
      "What is an idempotency key, and where is it stored?",
      "Why do payment systems use a double-entry ledger?",
      "How do you detect differences between your records and the provider's?",
    ],
  },
  {
    id: "ticket-booking",
    title: "Ticket booking",
    prompt:
      "Design a ticketing system like Ticketmaster or BookMyShow for concerts and movies with assigned seats.",
    difficulty: "medium",
    tags: ["concurrency", "reservations", "spiky-traffic"],
    requirements: {
      functional: [
        "Browse events and see available seats",
        "Hold seats for a few minutes while paying",
        "Confirm the booking after payment",
      ],
      nonFunctional: [
        "A seat is never sold twice",
        "Popular events: 1M users arrive the minute sales open",
        "Seat maps update in near real time",
      ],
    },
    hints: [
      "Two users click the same seat at the same moment. What guarantees only one gets it?",
      "How are held seats released if the user abandons payment?",
      "How would a virtual waiting room protect the system when sales open?",
      "Which reads can be served from a cache, and which must hit the source of truth?",
    ],
  },
  {
    id: "leaderboard",
    title: "Gaming leaderboard",
    prompt:
      "Design a real-time leaderboard for an online game showing top players and each player's own rank.",
    difficulty: "easy",
    tags: ["sorted-sets", "realtime", "sharding"],
    requirements: {
      functional: [
        "Submit a score after each match",
        "Show the global top 100",
        "Show a player's rank and the players around them",
        "Daily and all-time leaderboards",
      ],
      nonFunctional: [
        "50M players, 10k score updates per second",
        "Ranks are visible within a second of a match ending",
      ],
    },
    hints: [
      "Why is 'what is my rank?' slow with an ORDER BY in a relational database?",
      "Which data structure gives rank in O(log n)?",
      "How would you reset the daily leaderboard at midnight?",
      "How do you prevent clients from submitting fake scores?",
    ],
  },
  {
    id: "metrics-monitoring",
    title: "Metrics and monitoring",
    prompt:
      "Design a monitoring system like Datadog or Prometheus that collects metrics from thousands of servers and alerts on problems.",
    difficulty: "hard",
    tags: ["time-series", "ingestion", "alerting"],
    requirements: {
      functional: [
        "Collect metrics (CPU, latency, custom counters) from services",
        "Query and graph metrics over time",
        "Alert when a rule is broken (e.g. error rate above 5% for 5 minutes)",
      ],
      nonFunctional: [
        "10M data points per second",
        "Recent data queryable within 10 seconds",
        "Keep a year of history at reduced resolution",
      ],
    },
    hints: [
      "Push from agents or pull by the collector? What are the trade-offs?",
      "Why is a general-purpose database a poor fit? What would a time-series store do differently?",
      "How does downsampling old data save storage?",
      "The monitoring system itself breaks. How would you find out?",
    ],
  },
  {
    id: "collaborative-editor",
    title: "Collaborative document editor",
    prompt:
      "Design a collaborative document editor like Google Docs where several people edit the same document at once.",
    difficulty: "hard",
    tags: ["realtime", "crdt", "conflict-resolution"],
    requirements: {
      functional: [
        "Several users edit one document simultaneously",
        "See each other's cursors",
        "Edit offline and merge on reconnect",
        "Version history",
      ],
      nonFunctional: [
        "Edits appear for others within 200 ms",
        "No edits are lost when two users change the same sentence",
        "Up to 100 simultaneous editors per document",
      ],
    },
    hints: [
      "Two users type at the same position at once. What should the result be, and who decides?",
      "Compare operational transformation and CRDTs.",
      "Clients of one document are connected to different servers. How do edits reach all of them?",
      "How are edits stored so that loading a document stays fast after a million edits?",
    ],
  },
  {
    id: "ecommerce-checkout",
    title: "E-commerce checkout",
    prompt: "Design the cart, inventory and checkout flow of an online store during a flash sale.",
    difficulty: "medium",
    tags: ["inventory", "consistency", "spiky-traffic"],
    requirements: {
      functional: [
        "Add items to a cart",
        "Reserve inventory at checkout",
        "Pay and place the order; send a confirmation",
      ],
      nonFunctional: [
        "Never sell more items than are in stock",
        "Traffic is 50× normal during a flash sale",
        "The order is placed exactly once even if the user double-clicks",
      ],
    },
    hints: [
      "Where is the 'units left' number stored, and how is it decremented safely under contention?",
      "Which steps must happen before replying to the user, and which can happen after?",
      "What happens to reserved stock if payment fails?",
      "How do you keep a flash sale from taking down browsing for everyone else?",
    ],
  },
  {
    id: "job-scheduler",
    title: "Distributed job scheduler",
    prompt:
      "Design a service that runs scheduled and recurring jobs (like cron) across a cluster of workers.",
    difficulty: "medium",
    tags: ["scheduling", "leases", "at-least-once"],
    requirements: {
      functional: [
        "Schedule one-off and recurring (cron) jobs",
        "Run jobs on a pool of workers",
        "Retries with backoff; job status and logs",
      ],
      nonFunctional: [
        "1M jobs per day",
        "A job starts within a few seconds of its scheduled time",
        "A job is not run twice at the same time",
      ],
    },
    hints: [
      "How do workers find due jobs without all scanning the same table?",
      "A worker crashes mid-job. How does the system notice, and who picks it up?",
      "Exactly-once or at-least-once execution? What does that ask of job authors?",
      "The scheduler itself must not be a single point of failure.",
    ],
  },
  {
    id: "pastebin",
    title: "Pastebin",
    prompt: "Design a service like Pastebin for sharing snippets of text through a short link.",
    difficulty: "easy",
    tags: ["storage", "caching", "expiry"],
    requirements: {
      functional: [
        "Create a paste and get a link",
        "View a paste by its link",
        "Pastes expire after a chosen time; optional private pastes",
      ],
      nonFunctional: [
        "10M new pastes per day, pastes up to 10 MB",
        "Reads 10× writes",
        "Viewing a paste takes under 200 ms",
      ],
    },
    hints: [
      "Would you store 10 MB pastes in the database row or somewhere else?",
      "How do you generate short, unique, unguessable keys?",
      "How are expired pastes cleaned up without a slow full-table scan?",
      "Which pastes are worth caching, and where?",
    ],
  },
  {
    id: "hotel-booking",
    title: "Hotel reservation system",
    prompt: "Design the booking system of a hotel chain or a site like Booking.com.",
    difficulty: "medium",
    tags: ["transactions", "inventory", "search"],
    requirements: {
      functional: [
        "Search hotels by city and dates",
        "See room availability and prices",
        "Book, modify and cancel reservations",
      ],
      nonFunctional: [
        "No overbooking beyond the hotel's allowed limit",
        "Search results in under 500 ms",
        "5,000 hotels, 1M rooms",
      ],
    },
    hints: [
      "How would you model availability: per room, or per room type and date?",
      "Two guests book the last room at once. Pessimistic or optimistic locking?",
      "Search and booking have very different needs — should they use the same database?",
      "How do you handle a user who retries 'Book' after a timeout?",
    ],
  },
];

/** Validated once at startup, so a typo in the bank fails fast rather than mid-interview. */
export const QUESTION_BANK: readonly InterviewQuestion[] = z
  .array(interviewQuestionSchema)
  .parse(QUESTIONS);

export function findQuestion(id: string): InterviewQuestion | undefined {
  return QUESTION_BANK.find((q) => q.id === id);
}
