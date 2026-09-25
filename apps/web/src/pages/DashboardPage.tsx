import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Copy,
  Folder,
  FolderPlus,
  LayoutGrid,
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
            <DropdownMenuItem onSelect={() => void signOut(false)}>
              <LogOut aria-hidden="true" /> Sign out
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void signOut(true)}>
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
            <h1 className="text-2xl font-bold tracking-tight">Boards</h1>
            <Button
              onClick={() => {
                create.mutate();
              }}
              disabled={create.isPending}
            >
              <Plus aria-hidden="true" /> New board
            </Button>
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

  const run = (fn: () => Promise<unknown>) => {
    fn().then(onChanged, onError);
  };

  const card = (
    <>
      <div className="aspect-[16/10] overflow-hidden rounded-t-lg border-b bg-muted">
        {board.thumbnailUrl ? (
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
        <span className="block truncate font-medium">{board.title}</span>
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
            aria-label={`Actions for ${board.title}`}
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
                  onSelect={() => {
                    setRenaming(true);
                  }}
                >
                  <Pencil aria-hidden="true" /> Rename
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onSelect={() => {
                  api
                    .request(`/boards/${board.id}/duplicate`, {
                      method: "POST",
                      schema: boardDetailSchema,
                    })
                    .then((copy) => navigate(`/board/${copy.id}`), onError);
                }}
              >
                <Copy aria-hidden="true" /> Duplicate
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
        initial={board.title}
        onSubmit={(title) => {
          setRenaming(false);
          run(() =>
            api.request(`/boards/${board.id}`, {
              method: "PATCH",
              body: { title },
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
