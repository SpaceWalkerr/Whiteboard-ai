/**
 * Board thumbnails in a private Supabase Storage bucket. Only apps/server touches the bucket
 * (with the service-role key); browsers get short-lived signed URLs.
 */
export interface ThumbnailStorage {
  put(path: string, png: Uint8Array): Promise<void>;
  remove(paths: string[]): Promise<void>;
  /** Signed URLs (valid `expiresInSeconds`) keyed by path; missing objects are omitted. */
  signedUrls(paths: string[], expiresInSeconds: number): Promise<Map<string, string>>;
}

export const THUMBNAIL_BUCKET = "board-thumbnails";
export const THUMBNAIL_URL_TTL_SECONDS = 5 * 60;

export function thumbnailPath(boardId: string): string {
  return `${boardId}.png`;
}

/** Supabase Storage over its REST API (no extra SDK on the server). */
export class SupabaseThumbnailStorage implements ThumbnailStorage {
  constructor(
    private readonly supabaseUrl: string,
    private readonly serviceRoleKey: string,
    private readonly bucket = THUMBNAIL_BUCKET,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.serviceRoleKey}`,
      apikey: this.serviceRoleKey,
      ...extra,
    };
  }

  async put(path: string, png: Uint8Array): Promise<void> {
    const res = await fetch(
      `${this.supabaseUrl}/storage/v1/object/${this.bucket}/${encodeURIComponent(path)}`,
      {
        method: "POST",
        headers: this.headers({
          "content-type": "image/png",
          "x-upsert": "true",
          "cache-control": "no-cache",
        }),
        body: png,
      },
    );
    if (!res.ok) throw new Error(`thumbnail upload failed (${res.status})`);
  }

  async remove(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const res = await fetch(`${this.supabaseUrl}/storage/v1/object/${this.bucket}`, {
      method: "DELETE",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ prefixes: paths }),
    });
    if (!res.ok) throw new Error(`thumbnail delete failed (${res.status})`);
  }

  async signedUrls(paths: string[], expiresInSeconds: number): Promise<Map<string, string>> {
    const urls = new Map<string, string>();
    if (paths.length === 0) return urls;
    const res = await fetch(`${this.supabaseUrl}/storage/v1/object/sign/${this.bucket}`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ expiresIn: expiresInSeconds, paths }),
    });
    if (!res.ok) throw new Error(`thumbnail signing failed (${res.status})`);
    const body = (await res.json()) as {
      path?: string;
      signedURL?: string | null;
      error?: string | null;
    }[];
    for (const item of body) {
      if (item.path && item.signedURL)
        urls.set(item.path, `${this.supabaseUrl}/storage/v1${item.signedURL}`);
    }
    return urls;
  }
}

/** Tests and local development without a service key. */
export class MemoryThumbnailStorage implements ThumbnailStorage {
  readonly objects = new Map<string, Uint8Array>();

  put(path: string, png: Uint8Array): Promise<void> {
    this.objects.set(path, png);
    return Promise.resolve();
  }

  remove(paths: string[]): Promise<void> {
    for (const path of paths) this.objects.delete(path);
    return Promise.resolve();
  }

  signedUrls(paths: string[], expiresInSeconds: number): Promise<Map<string, string>> {
    return Promise.resolve(
      new Map(
        paths
          .filter((p) => this.objects.has(p))
          .map((p) => [p, `memory://${p}?expires=${expiresInSeconds}`]),
      ),
    );
  }
}
