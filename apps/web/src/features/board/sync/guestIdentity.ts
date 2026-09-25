import type { PresenceUser } from "@whiteboard/shared/sync";

/** Cursor colours: dark enough that white label text passes WCAG AA. */
export const PRESENCE_COLORS = [
  "#b91c1c",
  "#c2410c",
  "#a16207",
  "#15803d",
  "#0f766e",
  "#1d4ed8",
  "#6d28d9",
  "#be185d",
] as const;

const ADJECTIVES = [
  "Brave",
  "Calm",
  "Clever",
  "Eager",
  "Gentle",
  "Happy",
  "Keen",
  "Lucky",
  "Quick",
  "Quiet",
  "Swift",
  "Witty",
];
const ANIMALS = [
  "Otter",
  "Falcon",
  "Panda",
  "Lynx",
  "Heron",
  "Koala",
  "Badger",
  "Orca",
  "Fox",
  "Owl",
  "Yak",
  "Gecko",
];

const STORAGE_KEY = "whiteboard.guest";

function pick<T>(items: readonly T[], random: () => number): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error("empty list");
  return item;
}

export function randomGuest(random: () => number = Math.random): PresenceUser {
  return {
    id: `guest-${crypto.randomUUID()}`,
    name: `${pick(ADJECTIVES, random)} ${pick(ANIMALS, random)}`,
    color: pick(PRESENCE_COLORS, random),
  };
}

function isPresenceUser(value: unknown): value is PresenceUser {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    v.id.length > 0 &&
    typeof v.name === "string" &&
    v.name.trim().length > 0 &&
    v.name.length <= 40 &&
    typeof v.color === "string" &&
    /^#[0-9a-f]{6}$/i.test(v.color)
  );
}

/**
 * Guest identity until sign-in exists (Phase 4): a random name and colour kept per browser,
 * so a second (e.g. incognito) window is a different person. Storage can be unavailable
 * (private mode, blocked site data); then the identity just lasts for this page.
 */
export function loadGuest(): PresenceUser {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (isPresenceUser(stored)) return stored;
  } catch {
    // Fall through to a new identity.
  }
  const guest = randomGuest();
  saveGuest(guest);
  return guest;
}

export function saveGuest(guest: PresenceUser): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(guest));
  } catch {
    // Not persisted; fine for a guest.
  }
}
