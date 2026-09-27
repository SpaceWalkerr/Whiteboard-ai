import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Copy,
  Folder,
  FolderPlus,
  LayoutGrid,
  Lock,
  LogOut,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Link, useNavigate } from "react-router";
import { z } from "zod";
import {
  boardDetailSchema,
  boardListResponseSchema,
  type BoardSummary,
} from "@whiteboard/shared/api";
import { useAuth } from "@/auth/authContext";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { rememberedKeyCount } from "@/features/board/e2e/keyring";
import {
  createPrivateBoard,
  NEW_PRIVATE_BOARD_STATE,
  PRIVATE_LIMITS,
  renamePrivateBoard,
  usePrivateTitle,
} from "@/features/board/e2e/privateBoards";
import { withKey } from "@/features/board/e2e/roomKey";
import { UpgradeDialog } from "@/features/board/ui/UpgradeDialog";
import { ApiRequestError } from "@/lib/apiClient";
import { cn } from "@/lib/utils";

type View = "mine" | "shared" | "recent" | "trash";
const VIEWS: { id: View; label: string }[] = [
  { id: "mine", label: "My boards" },
  { id: "shared", label: "Shared with me" },
  { id: "recent", label: "Recent" },
  { id: "trash", label: "Trash" },
];

const foldersSchema = z.object({ folders: z.array(z.object({ id: z.uuid(), name: z.string() })) });
const folderSchema = z.object({ id: z.uuid(), name: z.string() });
type FolderItem = z.infer<typeof folderSchema>;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, ms);
    return () => {
      clearTimeout(timer);
    };
  }, [value, ms]);
  return debounced;
}

function errorText(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : "Something went wrong. Try again.";
}

/** /app — boards dashboard: my boards (with folders), shared with me, recent, trash, search. */
export function DashboardPage() {
  const { api, profile, session, signOut } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>("mine");
  const [folderId, setFolderId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 250);
  const [error, setError] = useState<string | null>(null);
  const searchId = useId();

  const params = new URLSearchParams({ view });
  if (q) params.set("q", q);
  if (view === "mine" && folderId) params.set("folderId", folderId);
  const boards = useQuery({
    queryKey: ["boards", view, q, view === "mine" ? folderId : null],
    queryFn: () => api.request(`/boards?${params.toString()}`, { schema: boardListResponseSchema }),
  });
  const folders = useQuery({
    queryKey: ["folders"],
    queryFn: () => api.request("/folders", { schema: foldersSchema }),
  });

  const folderName =
    view === "mine" ? folders.data?.folders.find((f) => f.id === folderId)?.name : undefined;

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["boards"] });
  };
  const onError = (e: unknown) => {
    setError(errorText(e));
  };
  const create = useMutation({
    mutationFn: () =>
      api.request("/boards", { method: "POST", body: { folderId }, schema: boardDetailSchema }),
    onSuccess: (board) => navigate(`/board/${board.id}`),
    onError,
  });
  const [upgradeMessage, setUpgradeMessage] = useState<string | null>(null);
  const createPrivate = useMutation({
    mutationFn: () => createPrivateBoard(api, folderId),
    onSuccess: ({ board, encodedKey }) =>
      navigate(withKey(`/board/${board.id}`, encodedKey), { state: NEW_PRIVATE_BOARD_STATE }),
    onError: (e) => {
      if (e instanceof ApiRequestError && e.status === 402) setUpgradeMessage(e.message);
      else onError(e);
    },
  });
  // Signing out wipes the keys of private boards from this device: warn first.
  const [signOutWarning, setSignOutWarning] = useState<{
    everywhere: boolean;
    keys: number;
  } | null>(null);
  const requestSignOut = (everywhere: boolean) => {
    void rememberedKeyCount().then((keys) => {
      if (keys > 0) setSignOutWarning({ everywhere, keys });
      else void signOut(everywhere);
    });
  };

  return (
    <div className="min-h-svh">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <Link to="/app" className="font-semibold">
          Whiteboard.ai
        </Link>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" aria-label="Account menu">
              {profile?.displayName ?? session?.user.email ?? "Account"}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled>{session?.user.email}</DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                requestSignOut(false);
              }}
            >
              <LogOut aria-hidden="true" /> Sign out
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                requestSignOut(true);
              }}
            >
              <LogOut aria-hidden="true" /> Sign out everywhere
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="mx-auto flex max-w-6xl gap-8 px-6 py-8">
        {view === "mine" && (
          <FolderSidebar
            folders={folders.data?.folders ?? []}
            selected={folderId}
            onSelect={setFolderId}
            onError={onError}
          />
        )}
        <main className="grid min-w-0 flex-1 content-start gap-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-2xl font-bold tracking-tight">{folderName ?? "Boards"}</h1>
            <div className="flex gap-2">
              <Button
                variant="outline"
                title="End-to-end encrypted: only people with the link's key can read it (Pro and Team)"
                onClick={() => {
                  createPrivate.mutate();
                }}
                disabled={createPrivate.isPending}
              >
                <Lock aria-hidden="true" /> New private board
              </Button>
              <Button
                onClick={() => {
                  create.mutate();
                }}
                disabled={create.isPending}
              >
                <Plus aria-hidden="true" /> New board
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div
              role="tablist"
              aria-label="Board views"
              className="flex gap-1 rounded-lg bg-muted p-1"
            >
              {VIEWS.map((v) => (
                <button
                  key={v.id}
                  role="tab"
                  type="button"
                  aria-selected={view === v.id}
                  onClick={() => {
                    setView(v.id);
                  }}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    view === v.id
                      ? "bg-background shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <div className="relative w-full sm:w-64">
              <Search
                aria-hidden="true"
                className="absolute top-2 left-2.5 size-4 text-muted-foreground"
              />
              <label htmlFor={searchId} className="sr-only">
                Search boards
              </label>
              <Input
                id={searchId}
                type="search"
                placeholder="Search boards"
                className="pl-8"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                }}
              />
            </div>
          </div>

          {error && (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          )}
          {q && <p className="text-xs text-muted-foreground">{PRIVATE_LIMITS.search}</p>}
          {view === "trash" && (
            <p className="text-sm text-muted-foreground">
              Deleted boards stay here for 30 days, then they're removed for good.
            </p>
          )}

          <section aria-label={VIEWS.find((v) => v.id === view)?.label} className="grid gap-3">
            {boards.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
            {boards.isError && (
              <p role="alert" className="text-sm text-destructive">
                Couldn't load boards.
              </p>
            )}
            {boards.data?.boards.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {q
                  ? `No boards match "${q}".`
                  : view === "mine"
                    ? "No boards yet — create one to get started."
                    : "Nothing here yet."}
              </p>
            )}
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {boards.data?.boards.map((board) => (
                <li key={board.id}>
                  <BoardCard
                    board={board}
                    view={view}
                    folders={folders.data?.folders ?? []}
                    onChanged={refresh}
                    onError={onError}
                  />
                </li>
              ))}
            </ul>
          </section>
        </main>
      </div>
      <UpgradeDialog
        message={upgradeMessage}
        onOpenChange={(open) => {
          if (!open) setUpgradeMessage(null);
        }}
      />
      <Dialog
        open={signOutWarning !== null}
        onOpenChange={(open) => {
          if (!open) setSignOutWarning(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Sign out and forget private board keys?</DialogTitle>
            <DialogDescription>
              Signing out removes the keys of {String(signOutWarning?.keys ?? 0)} private{" "}
              {signOutWarning?.keys === 1 ? "board" : "boards"} from this device. To open them again
              you&apos;ll need their links with the key. We can&apos;t recover a lost key.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setSignOutWarning(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const everywhere = signOutWarning?.everywhere ?? false;
                setSignOutWarning(null);
                void signOut(everywhere);
              }}
            >
              Sign out
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BoardCard({
  board,
  view,
  folders,
  onChanged,
  onError,
}: {
  board: BoardSummary;
  view: View;
  folders: FolderItem[];
  onChanged: () => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const { api, session } = useAuth();
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const owner = board.role === "owner";
  const trash = view === "trash";
  const privateTitle = usePrivateTitle(board);
  // A private board's title is shown only when this device has its key.
  const title = board.isPrivate ? (privateTitle ?? "Private board") : board.title;

  const run = (fn: () => Promise<unknown>) => {
    fn().then(onChanged, onError);
  };

  const card = (
    <>
      <div className="aspect-[16/10] overflow-hidden rounded-t-lg border-b bg-muted">
        {board.isPrivate ? (
          <div className="flex size-full flex-col items-center justify-center gap-1 text-muted-foreground">
            <Lock aria-hidden="true" className="size-6 opacity-60" />
            <span className="px-4 text-center text-xs">{PRIVATE_LIMITS.thumbnail}</span>
          </div>
        ) : board.thumbnailUrl ? (
          <img
            src={board.thumbnailUrl}
            alt=""
            className="size-full object-contain"
            loading="lazy"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            <LayoutGrid aria-hidden="true" className="size-8 opacity-40" />
          </div>
        )}
      </div>
      <div className="p-3 pr-10">
        <span className="flex items-center gap-1 truncate font-medium">
          {board.isPrivate && (
            <Lock aria-label="End-to-end encrypted" className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{title}</span>
        </span>
        <span className="text-xs text-muted-foreground">
          {trash
            ? `Deleted ${new Date(board.deletedAt ?? board.updatedAt).toLocaleDateString()}`
            : `${board.role === "owner" ? "Owner" : board.role === "editor" ? "Can edit" : "Can view"} · updated ${new Date(board.updatedAt).toLocaleDateString()}`}
        </span>
      </div>
    </>
  );

  return (
    <div className="relative rounded-lg border hover:bg-accent/40">
      {trash ? (
        <div>{card}</div>
      ) : (
        <Link
          to={`/board/${board.id}`}
          className="block rounded-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {card}
        </Link>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-1 bottom-2"
            aria-label={`Actions for ${title}`}
          >
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {trash ? (
            <DropdownMenuItem
              onSelect={() => {
                run(() =>
                  api.request(`/boards/${board.id}/restore`, {
                    method: "POST",
                    schema: boardDetailSchema,
                  }),
                );
              }}
            >
              <RotateCcw aria-hidden="true" /> Restore
            </DropdownMenuItem>
          ) : (
            <>
              {board.role !== "viewer" && (
                <DropdownMenuItem
                  // A private title can only be re-encrypted with the board's key.
                  disabled={board.isPrivate && privateTitle === null}
                  onSelect={() => {
                    setRenaming(true);
                  }}
                >
                  <Pencil aria-hidden="true" /> Rename
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                disabled={board.isPrivate}
                onSelect={() => {
                  api
                    .request(`/boards/${board.id}/duplicate`, {
                      method: "POST",
                      schema: boardDetailSchema,
                    })
                    .then((copy) => navigate(`/board/${copy.id}`), onError);
                }}
              >
                <Copy aria-hidden="true" />{" "}
                {board.isPrivate ? "Duplicate — not for encrypted boards" : "Duplicate"}
              </DropdownMenuItem>
              {owner && folders.length > 0 && (
                <>
                  {board.folderId && (
                    <DropdownMenuItem
                      onSelect={() => {
                        run(() =>
                          api.request(`/boards/${board.id}`, {
                            method: "PATCH",
                            body: { folderId: null },
                            schema: boardDetailSchema,
                          }),
                        );
                      }}
                    >
                      <Folder aria-hidden="true" /> Remove from folder
                    </DropdownMenuItem>
                  )}
                  {folders
                    .filter((f) => f.id !== board.folderId)
                    .map((folder) => (
                      <DropdownMenuItem
                        key={folder.id}
                        onSelect={() => {
                          run(() =>
                            api.request(`/boards/${board.id}`, {
                              method: "PATCH",
                              body: { folderId: folder.id },
                              schema: boardDetailSchema,
                            }),
                          );
                        }}
                      >
                        <Folder aria-hidden="true" /> Move to {folder.name}
                      </DropdownMenuItem>
                    ))}
                </>
              )}
              {owner ? (
                <DropdownMenuItem
                  onSelect={() => {
                    run(() => api.send(`/boards/${board.id}`, { method: "DELETE" }));
                  }}
                >
                  <Trash2 aria-hidden="true" /> Move to trash
                </DropdownMenuItem>
              ) : (
                view === "shared" && (
                  <DropdownMenuItem
                    onSelect={() => {
                      run(() =>
                        api.send(`/boards/${board.id}/members/${session?.user.id ?? ""}`, {
                          method: "DELETE",
                        }),
                      );
                    }}
                  >
                    <LogOut aria-hidden="true" /> Leave board
                  </DropdownMenuItem>
                )
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <NameDialog
        open={renaming}
        onOpenChange={setRenaming}
        title="Rename board"
        label="Board title"
        initial={title}
        onSubmit={(next) => {
          setRenaming(false);
          run(() =>
            board.isPrivate
              ? renamePrivateBoard(api, board.id, next)
              : api.request(`/boards/${board.id}`, {
                  method: "PATCH",
                  body: { title: next },
                  schema: boardDetailSchema,
                }),
          );
        }}
      />
    </div>
  );
}

function FolderSidebar({
  folders,
  selected,
  onSelect,
  onError,
}: {
  folders: FolderItem[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onError: (e: unknown) => void;
}) {
  const { api } = useAuth();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<
    { mode: "create" } | { mode: "rename"; folder: FolderItem } | null
  >(null);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["folders"] });
    await queryClient.invalidateQueries({ queryKey: ["boards"] });
  };
  const item =
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

  return (
    <nav aria-label="Folders" className="hidden w-52 shrink-0 md:block">
      <ul className="grid gap-0.5">
        <li>
          <button
            type="button"
            aria-current={selected === null ? "page" : undefined}
            className={cn(item, selected === null ? "bg-accent font-medium" : "hover:bg-accent/60")}
            onClick={() => {
              onSelect(null);
            }}
          >
            <LayoutGrid aria-hidden="true" className="size-4" /> All my boards
          </button>
        </li>
        {folders.map((folder) => (
          <li key={folder.id} className="group flex items-center">
            <button
              type="button"
              aria-current={selected === folder.id ? "page" : undefined}
              className={cn(
                item,
                "min-w-0 flex-1",
                selected === folder.id ? "bg-accent font-medium" : "hover:bg-accent/60",
              )}
              onClick={() => {
                onSelect(folder.id);
              }}
            >
              <Folder aria-hidden="true" className="size-4 shrink-0" />{" "}
              <span className="truncate">{folder.name}</span>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={`Actions for folder ${folder.name}`}
                >
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() => {
                    setDialog({ mode: "rename", folder });
                  }}
                >
                  <Pencil aria-hidden="true" /> Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    if (selected === folder.id) onSelect(null);
                    api.send(`/folders/${folder.id}`, { method: "DELETE" }).then(refresh, onError);
                  }}
                >
                  <Trash2 aria-hidden="true" /> Delete folder (keeps boards)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        ))}
      </ul>
      <Button
        variant="ghost"
        size="sm"
        className="mt-2 w-full justify-start"
        onClick={() => {
          setDialog({ mode: "create" });
        }}
      >
        <FolderPlus aria-hidden="true" /> New folder
      </Button>
      <NameDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title={dialog?.mode === "rename" ? "Rename folder" : "New folder"}
        label="Folder name"
        initial={dialog?.mode === "rename" ? dialog.folder.name : ""}
        onSubmit={(name) => {
          const current = dialog;
          setDialog(null);
          const request =
            current?.mode === "rename"
              ? api.request(`/folders/${current.folder.id}`, {
                  method: "PATCH",
                  body: { name },
                  schema: folderSchema,
                })
              : api.request("/folders", { method: "POST", body: { name }, schema: folderSchema });
          request.then(refresh, onError);
        }}
      />
    </nav>
  );
}

function NameDialog({
  open,
  onOpenChange,
  title,
  label,
  initial,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  label: string;
  initial: string;
  onSubmit: (value: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">{label}</DialogDescription>
        </DialogHeader>
        {open && <NameForm label={label} initial={initial} onSubmit={onSubmit} />}
      </DialogContent>
    </Dialog>
  );
}

function NameForm({
  label,
  initial,
  onSubmit,
}: {
  label: string;
  initial: string;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const id = useId();
  const trimmed = value.trim();
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (trimmed) onSubmit(trimmed);
      }}
    >
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Input
        id={id}
        value={value}
        maxLength={120}
        onChange={(e) => {
          setValue(e.target.value);
        }}
      />
      <Button type="submit" disabled={!trimmed}>
        Save
      </Button>
    </form>
  );
}
