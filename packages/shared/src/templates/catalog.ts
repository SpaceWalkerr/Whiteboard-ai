import type { Shape } from "../board/shapes";
import { buildTemplateShapes, type TemplateEdge, type TemplateNode } from "./build";

/** A classic system design, usable as a starting board and as a public page on the website. */
export interface BoardTemplate {
  /** URL slug and the id `POST /boards { templateId }` accepts. */
  slug: string;
  /** Short name ("URL shortener"). */
  name: string;
  /** Page heading, phrased the way people search for it. */
  heading: string;
  /** Meta description: at most 160 characters. */
  description: string;
  summary: string;
  functionalRequirements: readonly string[];
  nonFunctionalRequirements: readonly string[];
  components: readonly { name: string; why: string }[];
  /** How a typical request moves through the design, in order. */
  flow: readonly string[];
  tradeoffs: readonly string[];
  /** Follow-up questions an interviewer is likely to ask. */
  followUps: readonly string[];
  /** Last time the content changed (sitemap lastmod). */
  updated: string;
  shapes: readonly Shape[];
}

type TemplateDefinition = Omit<BoardTemplate, "shapes"> & {
  nodes: readonly TemplateNode[];
  edges: readonly TemplateEdge[];
};

const UPDATED = "2026-09-27";

const DEFINITIONS: readonly TemplateDefinition[] = [
  {
    slug: "url-shortener",
    name: "URL shortener",
    heading: "URL shortener system design diagram",
    description:
      "A URL shortener (like bit.ly) system design: key generation, redirect path with caching, click analytics and replicated storage.",
    summary:
      "A URL shortener turns a long link into a short code and redirects anyone who opens the code. Reads outnumber writes by 100:1 or more, so the design is built around a fast, cached redirect path, a collision-free way to generate codes, and click analytics that never slow the redirect down.",
    functionalRequirements: [
      "Create a short code for a long URL, optionally with a custom alias and an expiry.",
      "Redirect a short code to its long URL (HTTP 301/302).",
      "Count clicks per code for the owner's analytics.",
    ],
    nonFunctionalRequirements: [
      "Redirects in under 50 ms at p99; the redirect path must stay up even if analytics is down.",
      "Codes are unique and not guessable in sequence.",
      "Hundreds of millions of codes; read-heavy (about 100 redirects per new link).",
    ],
    components: [
      {
        name: "Load balancer",
        why: "Spreads redirect and create traffic across stateless service instances.",
      },
      {
        name: "Shortener service",
        why: "Creates codes and serves redirects; stateless so it scales horizontally.",
      },
      {
        name: "Key generation service",
        why: "Hands out pre-generated unique codes in batches, so two creates never collide and the service never retries on conflicts.",
      },
      {
        name: "Cache (code → URL)",
        why: "Popular codes are read constantly; a cache-aside Redis lookup keeps most redirects off the database.",
      },
      {
        name: "URL store (primary + replica)",
        why: "A key-value/NoSQL store keyed by code; the replica takes over if the primary fails.",
      },
      {
        name: "Click stream, worker and DLQ",
        why: "Redirects publish a click event and return immediately; a worker aggregates counts. Poison messages go to a dead-letter queue instead of blocking the stream.",
      },
    ],
    flow: [
      "Create: the service takes a code from the key generation service, writes code → URL to the store and returns the short link.",
      "Redirect: the service looks the code up in the cache; on a miss it reads the store and fills the cache.",
      "It responds with a redirect and publishes a click event to the stream without waiting.",
      "The analytics worker consumes clicks in batches and updates per-code counters.",
    ],
    tradeoffs: [
      "301 (permanent) redirects are cached by browsers and cut load, but hide repeat clicks from analytics; 302 keeps every click visible.",
      "Base62 codes of 7 characters give about 3.5 trillion combinations; hashing the URL instead dedupes identical links but needs collision handling.",
      "A pre-generated key range per instance avoids a central counter on the hot path at the cost of a few unused codes when an instance dies.",
    ],
    followUps: [
      "How do you handle custom aliases that collide with generated codes?",
      "How would you expire links and reclaim their codes?",
      "How do you stop abuse (malware links, enumeration)?",
    ],
    updated: UPDATED,
    nodes: [
      { id: "client", type: "client", label: "Browser / app", col: 0, row: 1 },
      { id: "lb", type: "load_balancer", label: "Load balancer", col: 1, row: 1 },
      { id: "svc", type: "service", label: "Shortener service", col: 2, row: 1 },
      { id: "kgs", type: "service", label: "Key generator", col: 2, row: 0 },
      { id: "cache", type: "cache", label: "Cache (code → URL)", col: 3, row: 0 },
      {
        id: "db",
        type: "database",
        label: "URL store",
        engine: "nosql",
        role: "primary",
        col: 3,
        row: 1,
      },
      {
        id: "replica",
        type: "database",
        label: "URL store replica",
        engine: "nosql",
        role: "replica",
        col: 4,
        row: 1,
      },
      { id: "clicks", type: "queue", label: "Click events", mode: "stream", col: 2, row: 2 },
      { id: "dlq", type: "queue", label: "Click events DLQ", col: 2, row: 3 },
      { id: "worker", type: "worker", label: "Analytics worker", col: 3, row: 2 },
    ],
    edges: [
      { from: "client", to: "lb", label: "GET /{code}" },
      { from: "lb", to: "svc" },
      { from: "svc", to: "kgs", label: "take key batch" },
      { from: "svc", to: "cache", label: "lookup" },
      { from: "svc", to: "db", label: "read / write" },
      { from: "db", to: "replica", type: "replication" },
      { from: "svc", to: "clicks", label: "click event", type: "async" },
      { from: "clicks", to: "worker", type: "async" },
      { from: "clicks", to: "dlq", label: "dead letters", type: "async" },
    ],
  },
  {
    slug: "rate-limiter",
    name: "Rate limiter",
    heading: "Distributed rate limiter system design diagram",
    description:
      "A distributed rate limiter system design: token bucket counters in Redis at the API gateway, rules service, and replicated rule storage.",
    summary:
      "A rate limiter caps how many requests a client may make in a time window, protecting services from abuse and noisy neighbours. In a fleet of gateways the counters must be shared, fast and atomic, and the limiter must fail in a predictable direction when its own storage is slow.",
    functionalRequirements: [
      "Limit requests per API key, user or IP with configurable rules (e.g. 100 requests/minute).",
      "Reject excess requests with HTTP 429 and a Retry-After header.",
      "Change rules without redeploying the gateways.",
    ],
    nonFunctionalRequirements: [
      "Adds under 2 ms to each request.",
      "Limits are shared across every gateway instance.",
      "If the counter store is unavailable, fail open for most routes (and closed for sensitive ones).",
    ],
    components: [
      {
        name: "API gateway (with limiter)",
        why: "Every request passes through it, so it is the one place that can enforce limits consistently.",
      },
      {
        name: "Counter cache (Redis)",
        why: "Holds token buckets or sliding-window counters; a Lua script checks and decrements atomically in one round trip.",
      },
      {
        name: "Rules service and store",
        why: "Owners edit limits here; gateways cache the rules locally and refresh them every few seconds.",
      },
      { name: "Backend services", why: "Only see traffic that passed the limiter." },
    ],
    flow: [
      "A request reaches the gateway, which identifies the caller (API key, user id or IP).",
      "The gateway runs an atomic check-and-decrement for the caller's bucket in Redis.",
      "If tokens remain the request is forwarded; otherwise the gateway answers 429 with Retry-After.",
      "Rules change in the rules service; gateways pick them up on their next refresh.",
    ],
    tradeoffs: [
      "Token bucket allows short bursts; a sliding-window log is exact but stores every timestamp; a sliding-window counter is a cheap approximation of both.",
      "Central counters are accurate but add a network hop; local counters synced periodically are faster but let clients exceed limits briefly.",
      "Failing open keeps the product up when Redis is down; failing closed protects fragile backends.",
    ],
    followUps: [
      "How do you rate limit across regions?",
      "How do you avoid a hot key for one very large customer?",
      "How do clients learn their remaining quota?",
    ],
    updated: UPDATED,
    nodes: [
      { id: "client", type: "client", label: "API clients", col: 0, row: 1 },
      { id: "lb", type: "load_balancer", label: "Load balancer", col: 1, row: 1 },
      { id: "gw", type: "api_gateway", label: "API gateway + limiter", col: 2, row: 1 },
      { id: "counters", type: "cache", label: "Counter cache (Redis)", col: 2, row: 0 },
      { id: "rules", type: "service", label: "Rules service", col: 3, row: 0 },
      { id: "rulesdb", type: "database", label: "Rules DB", col: 4, row: 0 },
      {
        id: "rulesreplica",
        type: "database",
        label: "Rules DB replica",
        role: "replica",
        col: 5,
        row: 0,
      },
      { id: "api", type: "service", label: "Backend services", col: 3, row: 1 },
    ],
    edges: [
      { from: "client", to: "lb" },
      { from: "lb", to: "gw" },
      { from: "gw", to: "counters", label: "check & decrement" },
      { from: "gw", to: "rules", label: "refresh rules" },
      { from: "rules", to: "rulesdb" },
      { from: "rulesdb", to: "rulesreplica", type: "replication" },
      { from: "gw", to: "api", label: "allowed requests" },
    ],
  },
  {
    slug: "chat-app",
    name: "Chat app",
    heading: "Chat application (WhatsApp) system design diagram",
    description:
      "A chat app system design like WhatsApp or Slack: WebSocket gateways, presence, message fan-out, offline push notifications and message storage.",
    summary:
      "A chat system delivers messages between users in real time, keeps them in order per conversation, and still delivers to people who are offline. The core pieces are long-lived WebSocket connections, a way to find which gateway a recipient is connected to, durable message storage, and push notifications for offline devices.",
    functionalRequirements: [
      "One-to-one and group messages with delivery and read receipts.",
      "Online/last-seen presence.",
      "Message history on every device; push notifications when offline.",
    ],
    nonFunctionalRequirements: [
      "Delivery in under 200 ms between online users.",
      "Messages are never lost once acknowledged, and are ordered within a conversation.",
      "Millions of concurrent connections.",
    ],
    components: [
      {
        name: "WebSocket gateways",
        why: "Hold each device's persistent connection; stateless apart from the sockets they hold.",
      },
      {
        name: "Chat service",
        why: "Validates, assigns a per-conversation sequence number, stores and routes messages.",
      },
      {
        name: "Session cache",
        why: "Maps user → gateway so the chat service knows where to deliver; also stores presence with a TTL.",
      },
      {
        name: "Message store (wide-column, replicated)",
        why: "Append-heavy, partitioned by conversation id and ordered by sequence number.",
      },
      {
        name: "Delivery stream, push worker and DLQ",
        why: "Offline recipients get a push notification through APNs/FCM without blocking the sender.",
      },
    ],
    flow: [
      "The sender's gateway forwards the message to the chat service.",
      "The chat service stores it (this is the durability point) and acknowledges the sender.",
      "It looks up each recipient's gateway in the session cache and delivers over their socket.",
      "Recipients with no live session get a delivery event; the push worker sends a notification.",
    ],
    tradeoffs: [
      "Per-conversation sequence numbers give ordering without global coordination.",
      "Fan-out on write for small groups is fast; very large channels are better served by fan-out on read.",
      "Storing messages before acknowledging costs a few milliseconds but means an ack is a promise.",
    ],
    followUps: [
      "How does a device catch up after being offline for a week?",
      "How would you add end-to-end encryption?",
      "What happens to open sockets when a gateway is deployed?",
    ],
    updated: UPDATED,
    nodes: [
      { id: "client", type: "client", label: "Mobile / web clients", col: 0, row: 1 },
      { id: "lb", type: "load_balancer", label: "Load balancer (WebSocket)", col: 1, row: 1 },
      { id: "gw", type: "api_gateway", label: "WebSocket gateways", col: 2, row: 1 },
      { id: "chat", type: "service", label: "Chat service", col: 3, row: 1 },
      { id: "sessions", type: "cache", label: "Session & presence cache", col: 3, row: 0 },
      {
        id: "store",
        type: "database",
        label: "Message store",
        engine: "nosql",
        col: 4,
        row: 1,
      },
      {
        id: "replica",
        type: "database",
        label: "Message store replica",
        engine: "nosql",
        role: "replica",
        col: 5,
        row: 1,
      },
      { id: "events", type: "queue", label: "Delivery events", mode: "stream", col: 3, row: 2 },
      { id: "dlq", type: "queue", label: "Delivery DLQ", col: 3, row: 3 },
      { id: "push", type: "worker", label: "Push worker", col: 4, row: 2 },
      { id: "apns", type: "external_api", label: "APNs / FCM", col: 5, row: 2 },
    ],
    edges: [
      { from: "client", to: "lb", label: "WebSocket" },
      { from: "lb", to: "gw" },
      { from: "gw", to: "chat", label: "send message" },
      { from: "chat", to: "sessions", label: "find recipient gateway" },
      { from: "chat", to: "store", label: "append" },
      { from: "store", to: "replica", type: "replication" },
      { from: "chat", to: "events", label: "offline recipients", type: "async" },
      { from: "events", to: "push", type: "async" },
      { from: "events", to: "dlq", label: "dead letters", type: "async" },
      { from: "push", to: "apns" },
    ],
  },
  {
    slug: "news-feed",
    name: "News feed",
    heading: "News feed (Twitter / Instagram) system design diagram",
    description:
      "A news feed system design like Twitter or Instagram: post service, fan-out workers, precomputed timelines in cache, media CDN and replicated storage.",
    summary:
      "A news feed shows each user recent posts from the accounts they follow. Reading the feed is far more frequent than posting, so the classic design precomputes each user's timeline when a post is created (fan-out on write) and serves it from a cache, with a special path for accounts that have millions of followers.",
    functionalRequirements: [
      "Publish posts with text and media.",
      "Show a user's home timeline, newest first, with pagination.",
      "Follow and unfollow accounts.",
    ],
    nonFunctionalRequirements: [
      "Timeline loads in under 200 ms at p99.",
      "A new post appears in followers' feeds within a few seconds (eventual consistency is fine).",
      "Hundreds of millions of daily users; reads dominate writes.",
    ],
    components: [
      {
        name: "Post service",
        why: "Validates and stores posts, then emits an event instead of doing fan-out inline.",
      },
      {
        name: "Fan-out stream and workers",
        why: "Insert the post id into each follower's timeline in the background; failures are retried and parked in a DLQ.",
      },
      {
        name: "Timeline cache",
        why: "A list of recent post ids per user, so reading the feed is one cache read plus a batch fetch.",
      },
      {
        name: "Feed service",
        why: "Reads the timeline, merges in posts from celebrity accounts at read time, and hydrates post details.",
      },
      {
        name: "Media storage and CDN",
        why: "Images and videos are served from the edge, never through the application servers.",
      },
    ],
    flow: [
      "A user posts; the post service stores it and emits a 'post created' event.",
      "Fan-out workers look up followers and push the post id into each timeline in the cache.",
      "A reader's feed service fetches their timeline ids, merges celebrity posts, and loads post bodies.",
      "The app loads media from the CDN.",
    ],
    tradeoffs: [
      "Fan-out on write makes reads cheap but a celebrity post means millions of writes; hybrid designs fan out on read for those accounts.",
      "Timelines keep only ids (and a bounded length) so the cache stays small; older pages come from the database.",
      "Ranking (not just time order) needs a separate scoring step and makes caching harder.",
    ],
    followUps: [
      "How do you handle a user who follows 5,000 accounts?",
      "How would you add ranking?",
      "How do deletes and blocks remove posts from already-built timelines?",
    ],
    updated: UPDATED,
    nodes: [
      { id: "client", type: "client", label: "Mobile / web app", col: 0, row: 1 },
      { id: "cdn", type: "cdn", label: "CDN", col: 0, row: 3 },
      { id: "lb", type: "load_balancer", label: "Load balancer", col: 1, row: 1 },
      { id: "posts", type: "service", label: "Post service", col: 2, row: 0 },
      { id: "feed", type: "service", label: "Feed service", col: 2, row: 1 },
      { id: "timeline", type: "cache", label: "Timeline cache", col: 3, row: 1 },
      { id: "db", type: "database", label: "Posts & follows DB", col: 3, row: 0 },
      {
        id: "replica",
        type: "database",
        label: "Posts DB replica",
        role: "replica",
        col: 4,
        row: 0,
      },
      { id: "fanout", type: "queue", label: "Post created", mode: "stream", col: 2, row: 2 },
      { id: "dlq", type: "queue", label: "Fan-out DLQ", col: 3, row: 3 },
      { id: "workers", type: "worker", label: "Fan-out workers", col: 3, row: 2 },
      { id: "media", type: "object_storage", label: "Media storage", col: 1, row: 3 },
    ],
    edges: [
      { from: "client", to: "lb" },
      { from: "client", to: "cdn", label: "images & video" },
      { from: "cdn", to: "media", label: "origin" },
      { from: "lb", to: "posts", label: "POST /posts" },
      { from: "lb", to: "feed", label: "GET /feed" },
      { from: "posts", to: "db", label: "write" },
      { from: "db", to: "replica", type: "replication" },
      { from: "posts", to: "fanout", type: "async" },
      { from: "fanout", to: "workers", type: "async" },
      { from: "fanout", to: "dlq", label: "dead letters", type: "async" },
      { from: "workers", to: "timeline", label: "push post id" },
      { from: "feed", to: "timeline", label: "read timeline" },
      { from: "feed", to: "db", label: "load posts" },
    ],
  },
  {
    slug: "ride-hailing",
    name: "Ride-hailing",
    heading: "Ride-hailing (Uber) system design diagram",
    description:
      "A ride-hailing system design like Uber or Ola: driver location updates, geospatial matching, trip state, payments and notifications.",
    summary:
      "A ride-hailing platform matches riders with nearby drivers in seconds. Drivers stream their location every few seconds, a geospatial index answers 'who is near this pickup point', and a trip service drives each ride through its states from request to payment.",
    functionalRequirements: [
      "Riders request a ride and see an ETA and price.",
      "Match the request to a nearby available driver who can accept or decline.",
      "Track the trip live and charge the rider at the end.",
    ],
    nonFunctionalRequirements: [
      "Match within a few seconds; location updates every 4–5 seconds from every active driver.",
      "A driver is never assigned to two trips at once.",
      "Payments are exactly-once from the rider's point of view.",
    ],
    components: [
      {
        name: "Location service and geo index",
        why: "Ingests driver pings and keeps the latest position of each available driver in an in-memory geospatial index (geohash/H3 cells).",
      },
      {
        name: "Matching service",
        why: "Queries nearby drivers, ranks them by ETA and offers the ride to one at a time with a timeout.",
      },
      {
        name: "Trip service and DB",
        why: "Owns the trip state machine; a conditional update ensures one driver per trip.",
      },
      {
        name: "Payment worker",
        why: "Charges the rider through the payment provider asynchronously with an idempotency key, retrying safely.",
      },
    ],
    flow: [
      "Driver apps send location pings; the location service updates the geo index.",
      "A rider requests a trip; the trip service creates it and asks matching for a driver.",
      "Matching queries the geo index, offers the trip to the best driver, and records the acceptance.",
      "When the trip ends an event triggers the payment worker, which charges the rider.",
    ],
    tradeoffs: [
      "Keeping locations only in memory is fast and cheap; losing them is acceptable because drivers resend within seconds.",
      "Offering to one driver at a time is fair but slower than broadcasting to several.",
      "Cell size in the geo index trades query precision against the number of cells searched.",
    ],
    followUps: [
      "How do you compute surge pricing per area?",
      "How would you handle a city with 100,000 active drivers?",
      "What happens if the rider's phone loses connectivity mid-trip?",
    ],
    updated: UPDATED,
    nodes: [
      { id: "rider", type: "client", label: "Rider app", col: 0, row: 0 },
      { id: "driver", type: "client", label: "Driver app", col: 0, row: 2 },
      { id: "gw", type: "api_gateway", label: "API gateway", col: 1, row: 1 },
      { id: "location", type: "service", label: "Location service", col: 2, row: 2 },
      { id: "geo", type: "cache", label: "Geo index (driver cells)", col: 3, row: 2 },
      { id: "trip", type: "service", label: "Trip service", col: 2, row: 0 },
      { id: "match", type: "service", label: "Matching service", col: 3, row: 1 },
      { id: "tripdb", type: "database", label: "Trips DB", col: 3, row: 0 },
      {
        id: "tripreplica",
        type: "database",
        label: "Trips DB replica",
        role: "replica",
        col: 4,
        row: 0,
      },
      { id: "events", type: "queue", label: "Trip completed", col: 4, row: 1 },
      { id: "dlq", type: "queue", label: "Payments DLQ", col: 5, row: 2 },
      { id: "payments", type: "worker", label: "Payment worker", col: 5, row: 1 },
      { id: "psp", type: "external_api", label: "Payment provider", col: 6, row: 1 },
    ],
    edges: [
      { from: "rider", to: "gw", label: "request ride" },
      { from: "driver", to: "gw", label: "location pings" },
      { from: "gw", to: "trip" },
      { from: "gw", to: "location" },
      { from: "location", to: "geo", label: "update position" },
      { from: "trip", to: "match", label: "find driver" },
      { from: "match", to: "geo", label: "nearby drivers" },
      { from: "trip", to: "tripdb" },
      { from: "tripdb", to: "tripreplica", type: "replication" },
      { from: "trip", to: "events", type: "async" },
      { from: "events", to: "payments", type: "async" },
      { from: "events", to: "dlq", label: "dead letters", type: "async" },
      { from: "payments", to: "psp", label: "charge (idempotent)" },
    ],
  },
  {
    slug: "video-streaming",
    name: "Video streaming",
    heading: "Video streaming (YouTube / Netflix) system design diagram",
    description:
      "A video streaming system design like YouTube or Netflix: resumable uploads, a transcoding pipeline, adaptive bitrate segments on a CDN and metadata storage.",
    summary:
      "A video platform accepts large uploads, transcodes each video into several resolutions and bitrates, and streams small segments from a CDN so playback adapts to the viewer's connection. Almost all bytes are served by the CDN; the application only handles metadata and the upload pipeline.",
    functionalRequirements: [
      "Upload videos (resumable, up to many GB).",
      "Transcode into multiple resolutions and generate thumbnails.",
      "Stream with adaptive bitrate (HLS/DASH) and show video metadata.",
    ],
    nonFunctionalRequirements: [
      "Playback starts in under 2 seconds and rarely rebuffers.",
      "Uploads survive interrupted connections.",
      "Storage and egress costs dominate: serve from the edge.",
    ],
    components: [
      {
        name: "Upload service and object storage",
        why: "Issues pre-signed URLs so clients upload chunks straight to storage, not through app servers.",
      },
      {
        name: "Transcode queue and workers",
        why: "Split each video into segments and encode them in parallel; failed jobs are retried and parked in a DLQ.",
      },
      {
        name: "Video metadata DB",
        why: "Title, owner, status and the manifest location for each rendition.",
      },
      {
        name: "CDN",
        why: "Serves manifests and segments near viewers; the origin is object storage.",
      },
    ],
    flow: [
      "The client asks the upload service for pre-signed URLs and uploads chunks to storage.",
      "On completion a transcode job is queued; workers write renditions, segments and thumbnails back to storage.",
      "Workers mark the video ready in the metadata DB.",
      "Players fetch the manifest and segments from the CDN, switching bitrate as bandwidth changes.",
    ],
    tradeoffs: [
      "Pre-encoding every rendition costs storage for rarely watched videos; encoding long-tail videos on demand saves storage but delays first playback.",
      "Short segments adapt faster but add request overhead.",
      "Per-title encoding settings improve quality per bit at extra compute cost.",
    ],
    followUps: [
      "How do you count views accurately at scale?",
      "How would you support live streaming?",
      "How do you keep popular videos warm on the CDN in every region?",
    ],
    updated: UPDATED,
    nodes: [
      { id: "client", type: "client", label: "Player / uploader", col: 0, row: 1 },
      { id: "cdn", type: "cdn", label: "CDN", col: 1, row: 2 },
      { id: "lb", type: "load_balancer", label: "Load balancer", col: 1, row: 0 },
      { id: "upload", type: "service", label: "Upload & metadata service", col: 2, row: 0 },
      { id: "storage", type: "object_storage", label: "Video storage", col: 2, row: 2 },
      { id: "meta", type: "database", label: "Video metadata DB", col: 3, row: 0 },
      {
        id: "metareplica",
        type: "database",
        label: "Metadata replica",
        role: "replica",
        col: 4,
        row: 0,
      },
      { id: "jobs", type: "queue", label: "Transcode jobs", col: 3, row: 1 },
      { id: "dlq", type: "queue", label: "Transcode DLQ", col: 4, row: 2 },
      { id: "workers", type: "worker", label: "Transcode workers", col: 4, row: 1 },
    ],
    edges: [
      { from: "client", to: "lb", label: "upload / metadata" },
      { from: "client", to: "cdn", label: "stream segments" },
      { from: "cdn", to: "storage", label: "origin" },
      { from: "lb", to: "upload" },
      { from: "upload", to: "storage", label: "pre-signed upload URLs" },
      { from: "upload", to: "meta" },
      { from: "meta", to: "metareplica", type: "replication" },
      { from: "upload", to: "jobs", label: "transcode", type: "async" },
      { from: "jobs", to: "workers", type: "async" },
      { from: "jobs", to: "dlq", label: "dead letters", type: "async" },
      { from: "workers", to: "storage", label: "write renditions" },
      { from: "workers", to: "meta", label: "mark ready" },
    ],
  },
  {
    slug: "notification-system",
    name: "Notification system",
    heading: "Notification system design diagram (push, email, SMS)",
    description:
      "A notification service system design: one API for push, email and SMS, per-channel queues and workers, user preferences, retries and dead-letter queues.",
    summary:
      "A notification system lets every product team send push, email and SMS messages through one API. It checks user preferences and rate limits, then hands each message to a channel-specific queue so a slow email provider never delays push notifications.",
    functionalRequirements: [
      "Send a notification to a user on one or more channels (push, email, SMS).",
      "Respect user preferences, quiet hours and unsubscribe.",
      "Track delivery status per message.",
    ],
    nonFunctionalRequirements: [
      "At-least-once delivery with deduplication, so users don't get the same message twice.",
      "One channel's outage doesn't affect the others.",
      "Millions of notifications per hour at peak.",
    ],
    components: [
      {
        name: "Notification service",
        why: "Validates requests, applies preferences and templates, assigns an idempotency key and enqueues per channel.",
      },
      {
        name: "Preferences cache and DB",
        why: "Every send checks preferences, so they are cached; the DB is the source of truth.",
      },
      {
        name: "Per-channel queues and workers",
        why: "Isolate channels so each scales and fails independently.",
      },
      {
        name: "Providers (APNs/FCM, email, SMS)",
        why: "External services with their own rate limits; workers retry with backoff.",
      },
    ],
    flow: [
      "A product service calls the notification API.",
      "The service loads the user's preferences and renders the message for each allowed channel.",
      "It puts one job per channel on that channel's queue and records the message.",
      "Channel workers call the provider, retry with backoff on failure, and park repeated failures in a DLQ.",
    ],
    tradeoffs: [
      "Separate queues per channel cost more to operate but stop one provider's outage from backing up everything.",
      "Deduplicating on an idempotency key makes retries safe but needs a short-lived key store.",
      "Batching digests reduces notification fatigue but delays individual messages.",
    ],
    followUps: [
      "How do you prioritise a password-reset email over a marketing email?",
      "How do you handle a user with 10 devices?",
      "How would you measure delivery and open rates?",
    ],
    updated: UPDATED,
    nodes: [
      { id: "producers", type: "service", label: "Product services", col: 0, row: 1 },
      { id: "gw", type: "api_gateway", label: "API gateway", col: 1, row: 1 },
      { id: "notify", type: "service", label: "Notification service", col: 2, row: 1 },
      { id: "prefs", type: "cache", label: "Preferences cache", col: 2, row: 0 },
      { id: "db", type: "database", label: "Notifications DB", col: 3, row: 0 },
      {
        id: "replica",
        type: "database",
        label: "Notifications DB replica",
        role: "replica",
        col: 4,
        row: 0,
      },
      { id: "pushq", type: "queue", label: "Push queue", col: 3, row: 1 },
      { id: "emailq", type: "queue", label: "Email queue", col: 3, row: 2 },
      { id: "dlq", type: "queue", label: "Notifications DLQ", col: 3, row: 3 },
      { id: "pushw", type: "worker", label: "Push workers", col: 4, row: 1 },
      { id: "emailw", type: "worker", label: "Email & SMS workers", col: 4, row: 2 },
      { id: "apns", type: "external_api", label: "APNs / FCM", col: 5, row: 1 },
      { id: "email", type: "external_api", label: "Email / SMS providers", col: 5, row: 2 },
    ],
    edges: [
      { from: "producers", to: "gw", label: "send notification" },
      { from: "gw", to: "notify" },
      { from: "notify", to: "prefs", label: "preferences" },
      { from: "notify", to: "db", label: "record message" },
      { from: "db", to: "replica", type: "replication" },
      { from: "notify", to: "pushq", type: "async" },
      { from: "notify", to: "emailq", type: "async" },
      { from: "pushq", to: "pushw", type: "async" },
      { from: "emailq", to: "emailw", type: "async" },
      { from: "pushq", to: "dlq", label: "dead letters", type: "async" },
      { from: "emailq", to: "dlq", label: "dead letters", type: "async" },
      { from: "pushw", to: "apns" },
      { from: "emailw", to: "email" },
    ],
  },
  {
    slug: "web-crawler",
    name: "Web crawler",
    heading: "Web crawler system design diagram",
    description:
      "A web crawler system design: URL frontier, polite per-host fetching, DNS cache, content dedup, parser workers and document storage.",
    summary:
      "A web crawler downloads billions of pages by repeatedly taking URLs from a frontier, fetching them politely, storing the content and adding newly discovered links back to the frontier. The hard parts are politeness (never overloading a site), deduplication, and staying robust against traps and malformed pages.",
    functionalRequirements: [
      "Crawl pages starting from seed URLs and follow links.",
      "Respect robots.txt and per-host rate limits.",
      "Store page content for indexing and re-crawl pages periodically.",
    ],
    nonFunctionalRequirements: [
      "Billions of pages per month; horizontally scalable fetchers.",
      "Never fetch the same URL (or identical content) twice in a cycle.",
      "Tolerant of slow, huge or malicious pages.",
    ],
    components: [
      {
        name: "URL frontier",
        why: "A prioritised queue partitioned by host, so each host is fetched by one worker at a polite rate.",
      },
      {
        name: "Fetcher workers and DNS cache",
        why: "Download pages with timeouts and size limits; cached DNS avoids a lookup per request.",
      },
      {
        name: "Parser workers",
        why: "Extract links and text; new links are normalised, checked against the seen-URL store and added to the frontier.",
      },
      {
        name: "Seen-URL store and content storage",
        why: "Deduplicate URLs and content fingerprints; raw pages go to object storage for the indexer.",
      },
    ],
    flow: [
      "Fetchers take the next URL for a host from the frontier and fetch it (after checking robots.txt).",
      "The page is written to storage and a parse job is queued.",
      "Parsers extract links, drop ones already seen, and add the rest to the frontier.",
      "A scheduler re-enqueues pages for re-crawl based on how often they change.",
    ],
    tradeoffs: [
      "BFS finds important pages early; priority by estimated importance does it better but needs a ranking signal.",
      "Bloom filters make 'seen before' checks cheap in memory at the cost of rare false positives (a skipped URL).",
      "Re-crawl frequency trades freshness against bandwidth and politeness.",
    ],
    followUps: [
      "How do you detect crawler traps (infinite calendars)?",
      "How do you crawl pages that need JavaScript to render?",
      "How do you distribute the frontier across machines?",
    ],
    updated: UPDATED,
    nodes: [
      { id: "seeds", type: "service", label: "Seed & re-crawl scheduler", col: 0, row: 1 },
      { id: "frontier", type: "queue", label: "URL frontier (per host)", col: 1, row: 1 },
      { id: "dlq", type: "queue", label: "Failed URLs (retry later)", col: 1, row: 2 },
      { id: "fetchers", type: "worker", label: "Fetcher workers", col: 2, row: 1 },
      { id: "dns", type: "cache", label: "DNS & robots.txt cache", col: 2, row: 0 },
      { id: "web", type: "external_api", label: "Websites", col: 3, row: 0 },
      { id: "pages", type: "object_storage", label: "Page storage", col: 3, row: 1 },
      { id: "parseq", type: "queue", label: "Parse jobs", col: 2, row: 2 },
      { id: "parsedlq", type: "queue", label: "Parse DLQ", col: 2, row: 3 },
      { id: "parsers", type: "worker", label: "Parser workers", col: 3, row: 2 },
      {
        id: "seen",
        type: "database",
        label: "Seen URLs & fingerprints",
        engine: "nosql",
        col: 4,
        row: 2,
      },
      {
        id: "seenreplica",
        type: "database",
        label: "Seen URLs replica",
        engine: "nosql",
        role: "replica",
        col: 5,
        row: 2,
      },
    ],
    edges: [
      { from: "seeds", to: "frontier", type: "async" },
      { from: "frontier", to: "fetchers", type: "async" },
      { from: "frontier", to: "dlq", label: "retry later", type: "async" },
      { from: "fetchers", to: "dns" },
      { from: "fetchers", to: "web", label: "HTTP GET" },
      { from: "fetchers", to: "pages", label: "store page" },
      { from: "fetchers", to: "parseq", type: "async" },
      { from: "parseq", to: "parsers", type: "async" },
      { from: "parseq", to: "parsedlq", label: "dead letters", type: "async" },
      { from: "parsers", to: "seen", label: "dedupe links" },
      { from: "seen", to: "seenreplica", type: "replication" },
      { from: "parsers", to: "frontier", label: "new URLs", type: "async" },
    ],
  },
  {
    slug: "distributed-cache",
    name: "Distributed cache",
    heading: "Distributed cache (Redis / Memcached) system design diagram",
    description:
      "A distributed cache system design: consistent hashing across cache nodes, replicas for failover, cache-aside reads and invalidation on writes.",
    summary:
      "A distributed cache spreads hot data across many memory nodes so reads skip the database. Consistent hashing decides which node owns each key, replicas take over when a node dies, and the application keeps the cache correct with cache-aside reads and invalidation on writes.",
    functionalRequirements: [
      "get / set / delete with a TTL per key.",
      "Add or remove cache nodes without remapping most keys.",
      "Survive a node failure without a thundering herd on the database.",
    ],
    nonFunctionalRequirements: [
      "Sub-millisecond reads within a region.",
      "Hundreds of GB of hot data; millions of operations per second.",
      "Stale data bounded by TTL or explicit invalidation.",
    ],
    components: [
      {
        name: "Cache client library",
        why: "Hashes keys onto a consistent-hash ring (with virtual nodes) to pick the owning shard.",
      },
      {
        name: "Cache shards with replicas",
        why: "Each shard is a primary with a replica; a failover promotes the replica.",
      },
      {
        name: "Config service",
        why: "Publishes the current ring membership so clients agree on key ownership.",
      },
      {
        name: "Database",
        why: "Source of truth; the cache is always safe to lose.",
      },
    ],
    flow: [
      "The app service hashes the key and reads from the owning shard.",
      "On a miss it reads the database, then writes the value to the cache with a TTL.",
      "Writes go to the database first, then delete the cache key.",
      "When membership changes the config service publishes the new ring and only about 1/N of keys move.",
    ],
    tradeoffs: [
      "Cache-aside is simple and resilient; write-through keeps the cache warm but writes are slower.",
      "Deleting on write (rather than updating) avoids races that leave stale values.",
      "Request coalescing or short 'lease' locks stop many clients recomputing the same missing key.",
    ],
    followUps: [
      "How do you handle a single extremely hot key?",
      "What eviction policy would you choose and why?",
      "How do you warm a new node?",
    ],
    updated: UPDATED,
    nodes: [
      { id: "client", type: "client", label: "Users", col: 0, row: 1 },
      { id: "lb", type: "load_balancer", label: "Load balancer", col: 1, row: 1 },
      { id: "app", type: "service", label: "App service (cache client)", col: 2, row: 1 },
      { id: "config", type: "service", label: "Ring config service", col: 2, row: 0 },
      { id: "shard1", type: "cache", label: "Cache shard A", col: 3, row: 0 },
      { id: "shard2", type: "cache", label: "Cache shard B", col: 3, row: 1 },
      { id: "db", type: "database", label: "Database", col: 3, row: 2 },
      {
        id: "replica",
        type: "database",
        label: "Database replica",
        role: "replica",
        col: 4,
        row: 2,
      },
    ],
    edges: [
      { from: "client", to: "lb" },
      { from: "lb", to: "app" },
      { from: "app", to: "config", label: "ring membership" },
      { from: "app", to: "shard1", label: "get / set" },
      { from: "app", to: "shard2", label: "get / set" },
      { from: "app", to: "db", label: "read on miss / write" },
      { from: "db", to: "replica", type: "replication" },
    ],
  },
  {
    slug: "payment-system",
    name: "Payment system",
    heading: "Payment system design diagram",
    description:
      "A payment system design: idempotent payment API, double-entry ledger, payment service provider integration, webhooks and reconciliation.",
    summary:
      "A payment system moves money correctly even when networks fail halfway. Every request carries an idempotency key, the external payment provider is the only thing that touches cards, a double-entry ledger records every movement, and reconciliation against the provider's reports catches anything that slipped through.",
    functionalRequirements: [
      "Charge a customer for an order and refund it.",
      "Record every movement of money in a ledger.",
      "Handle asynchronous provider results (webhooks) and reconcile daily.",
    ],
    nonFunctionalRequirements: [
      "Exactly-once from the customer's point of view: retries never double-charge.",
      "Strong consistency and a full audit trail.",
      "Card data never touches our servers (PCI scope stays small).",
    ],
    components: [
      {
        name: "Payment service",
        why: "Creates payment intents with an idempotency key and drives their state machine.",
      },
      {
        name: "Payment service provider",
        why: "Collects card/UPI details in its own hosted checkout and executes the charge.",
      },
      {
        name: "Ledger DB (primary + replica)",
        why: "Double-entry, append-only records; balances are derived, never edited.",
      },
      {
        name: "Webhook handler and events",
        why: "Verifies provider signatures, deduplicates by event id, and emits payment events for fulfilment.",
      },
      {
        name: "Reconciliation worker",
        why: "Compares the ledger with the provider's settlement reports and flags mismatches.",
      },
    ],
    flow: [
      "Checkout calls the payment service with an idempotency key; it stores a pending payment.",
      "The client completes payment in the provider's hosted checkout.",
      "The provider sends a signed webhook; the handler verifies it, updates the payment and writes ledger entries in one transaction.",
      "A payment event triggers fulfilment; a nightly worker reconciles against settlement files.",
    ],
    tradeoffs: [
      "Relying on webhooks alone is fragile; also polling the provider for pending payments closes the gap.",
      "Synchronous charging gives instant answers but ties your availability to the provider's.",
      "An append-only ledger is more work than updating a balance column, but it can always explain every number.",
    ],
    followUps: [
      "How do you guarantee a retried request doesn't charge twice?",
      "What happens if the webhook arrives before your own database write commits?",
      "How would you support multiple currencies?",
    ],
    updated: UPDATED,
    nodes: [
      { id: "client", type: "client", label: "Checkout (web / app)", col: 0, row: 1 },
      { id: "gw", type: "api_gateway", label: "API gateway", col: 1, row: 1 },
      { id: "pay", type: "service", label: "Payment service", col: 2, row: 1 },
      { id: "psp", type: "external_api", label: "Payment provider", col: 2, row: 0 },
      { id: "hooks", type: "service", label: "Webhook handler", col: 3, row: 0 },
      { id: "ledger", type: "database", label: "Ledger DB", col: 3, row: 1 },
      {
        id: "replica",
        type: "database",
        label: "Ledger replica",
        role: "replica",
        col: 4,
        row: 1,
      },
      { id: "events", type: "queue", label: "Payment events", col: 3, row: 2 },
      { id: "dlq", type: "queue", label: "Payment events DLQ", col: 3, row: 3 },
      { id: "fulfil", type: "worker", label: "Fulfilment & reconciliation", col: 4, row: 2 },
    ],
    edges: [
      { from: "client", to: "gw", label: "pay (idempotency key)" },
      { from: "gw", to: "pay" },
      { from: "pay", to: "psp", label: "create order" },
      { from: "pay", to: "ledger", label: "pending payment" },
      { from: "psp", to: "hooks", label: "signed webhook", type: "async" },
      { from: "hooks", to: "ledger", label: "settle + ledger entries" },
      { from: "ledger", to: "replica", type: "replication" },
      { from: "hooks", to: "events", type: "async" },
      { from: "events", to: "fulfil", type: "async" },
      { from: "events", to: "dlq", label: "dead letters", type: "async" },
    ],
  },
];

export const BOARD_TEMPLATES: readonly BoardTemplate[] = DEFINITIONS.map(
  ({ nodes, edges, ...template }) => ({ ...template, shapes: buildTemplateShapes(nodes, edges) }),
);

const bySlug = new Map(BOARD_TEMPLATES.map((template) => [template.slug, template]));

export function templateBySlug(slug: string): BoardTemplate | undefined {
  return bySlug.get(slug);
}

export const TEMPLATE_SLUGS = BOARD_TEMPLATES.map((template) => template.slug);
