import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Link2, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { useNavigate } from "react-router";
import { z } from "zod";
import {
  createdShareLinkSchema,
  pendingInviteSchema,
  sharingStateSchema,
  type Member,
  type ShareRole,
} from "@whiteboard/shared/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/auth/authContext";
import { ApiRequestError } from "@/lib/apiClient";

interface ShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  boardId: string;
  /** Owners manage members, invites, links and public access; others see who's here. */
  canManage: boolean;
}

const ROLE_LABELS: Record<ShareRole, string> = { editor: "Can edit", viewer: "Can view" };

function errorText(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : "Something went wrong. Try again.";
}

function RoleSelect({
  value,
  onChange,
  label,
  id,
}: {
  value: ShareRole;
  onChange: (role: ShareRole) => void;
  label: string;
  id?: string;
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => {
        if (v === "editor" || v === "viewer") onChange(v);
      }}
    >
      <SelectTrigger id={id} aria-label={label} className="w-32">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="editor">{ROLE_LABELS.editor}</SelectItem>
        <SelectItem value="viewer">{ROLE_LABELS.viewer}</SelectItem>
      </SelectContent>
    </Select>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => {
            setCopied(false);
          }, 2000);
        });
      }}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {copied ? "Copied" : label}
    </Button>
  );
}

export function ShareDialog({ open, onOpenChange, boardId, canManage }: ShareDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share board</DialogTitle>
          <DialogDescription>
            {canManage
              ? "Invite people, create links and control who can see this board."
              : "People with access to this board."}
          </DialogDescription>
        </DialogHeader>
        {open && <ShareDialogBody boardId={boardId} canManage={canManage} />}
      </DialogContent>
    </Dialog>
  );
}

function ShareDialogBody({ boardId, canManage }: { boardId: string; canManage: boolean }) {
  const { api, session } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const key = ["sharing", boardId];
  const sharing = useQuery({
    queryKey: key,
    queryFn: () => api.request(`/boards/${boardId}/sharing`, { schema: sharingStateSchema }),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const [error, setError] = useState<string | null>(null);
  const onError = (e: unknown) => {
    setError(errorText(e));
  };
  const boardUrl = `${window.location.origin}/board/${boardId}`;

  const updateRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: ShareRole }) =>
      api.request(`/boards/${boardId}/members/${userId}`, {
        method: "PATCH",
        body: { role },
        schema: z.object({ role: z.string() }),
      }),
    onSuccess: refresh,
    onError,
  });
  const removeMember = useMutation({
    mutationFn: (userId: string) =>
      api.send(`/boards/${boardId}/members/${userId}`, { method: "DELETE" }),
    onSuccess: async (_data, userId) => {
      if (userId === session?.user.id) await navigate("/app");
      else await refresh();
    },
    onError,
  });
  const revokeInvite = useMutation({
    mutationFn: (inviteId: string) =>
      api.send(`/boards/${boardId}/invites/${inviteId}`, { method: "DELETE" }),
    onSuccess: refresh,
    onError,
  });
  const revokeLink = useMutation({
    mutationFn: (linkId: string) =>
      api.send(`/boards/${boardId}/share-links/${linkId}`, { method: "DELETE" }),
    onSuccess: refresh,
    onError,
  });
  const setPublic = useMutation({
    mutationFn: (isPublic: boolean) =>
      api.request(`/boards/${boardId}/sharing`, {
        method: "PATCH",
        body: { isPublic },
        schema: z.object({ isPublic: z.boolean() }),
      }),
    onSuccess: refresh,
    onError,
  });

  if (sharing.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading…
      </p>
    );
  if (sharing.isError)
    return (
      <p role="alert" className="text-sm text-destructive">
        {errorText(sharing.error)}
      </p>
    );
  const state = sharing.data;
  const me = session?.user.id;

  return (
    <div className="grid gap-5">
      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {canManage && (
        <InviteForm
          boardId={boardId}
          onInvited={() => {
            setError(null);
            void refresh();
          }}
          onError={onError}
        />
      )}

      <section aria-labelledby="members-heading" className="grid gap-2">
        <h3 id="members-heading" className="text-sm font-semibold">
          People with access
        </h3>
        <ul className="grid gap-2">
          {state.members.map((member) => (
            <MemberRow
              key={member.userId}
              member={member}
              isMe={member.userId === me}
              canManage={canManage}
              onRole={(role) => {
                updateRole.mutate({ userId: member.userId, role });
              }}
              onRemove={() => {
                removeMember.mutate(member.userId);
              }}
            />
          ))}
          {state.invites.map((invite) => (
            <li key={invite.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate">
                {invite.email}{" "}
                <span className="text-muted-foreground">
                  · invited, {ROLE_LABELS[invite.role].toLowerCase()}
                </span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  revokeInvite.mutate(invite.id);
                }}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      </section>

      {canManage && (
        <LinksSection
          boardId={boardId}
          links={state.links}
          onChanged={refresh}
          onRevoke={(id) => {
            revokeLink.mutate(id);
          }}
          onError={onError}
        />
      )}

      {canManage && (
        <section aria-labelledby="public-heading" className="grid gap-2">
          <h3 id="public-heading" className="text-sm font-semibold">
            Public access
          </h3>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={state.isPublic}
              onChange={(e) => {
                setPublic.mutate(e.target.checked);
              }}
            />
            Anyone with the board's link can view it, without signing in
          </label>
        </section>
      )}

      <div className="flex justify-end">
        <CopyButton text={boardUrl} label="Copy board link" />
      </div>
    </div>
  );
}

function MemberRow({
  member,
  isMe,
  canManage,
  onRole,
  onRemove,
}: {
  member: Member;
  isMe: boolean;
  canManage: boolean;
  onRole: (role: ShareRole) => void;
  onRemove: () => void;
}) {
  const shareRole: ShareRole | null = member.role === "owner" ? null : member.role;
  const owner = shareRole === null;
  return (
    <li className="flex items-center justify-between gap-2 text-sm">
      <span className="min-w-0 truncate">
        {member.displayName}
        {isMe && <span className="text-muted-foreground"> (you)</span>}
        {member.email && (
          <span className="block truncate text-xs text-muted-foreground">{member.email}</span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {owner && <span className="text-xs text-muted-foreground">Owner</span>}
        {shareRole !== null && canManage && (
          <RoleSelect
            value={shareRole}
            onChange={onRole}
            label={`Role for ${member.displayName}`}
          />
        )}
        {shareRole !== null && !canManage && (
          <span className="text-xs text-muted-foreground">{ROLE_LABELS[shareRole]}</span>
        )}
        {!owner && (canManage || isMe) && (
          <Button
            variant="ghost"
            size="sm"
            aria-label={isMe ? "Leave this board" : `Remove ${member.displayName}`}
            onClick={onRemove}
          >
            {isMe ? "Leave" : <Trash2 aria-hidden="true" />}
          </Button>
        )}
      </span>
    </li>
  );
}

function InviteForm({
  boardId,
  onInvited,
  onError,
}: {
  boardId: string;
  onInvited: () => void;
  onError: (e: unknown) => void;
}) {
  const { api } = useAuth();
  const emailId = useId();
  const roleId = useId();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ShareRole>("editor");
  const invite = useMutation({
    mutationFn: () =>
      api.request(`/boards/${boardId}/invites`, {
        method: "POST",
        body: { email, role },
        schema: pendingInviteSchema,
      }),
    onSuccess: () => {
      setEmail("");
      onInvited();
    },
    onError,
  });
  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        invite.mutate();
      }}
    >
      <label htmlFor={emailId} className="text-sm font-semibold">
        Invite by email
      </label>
      <div className="flex gap-2">
        <Input
          id={emailId}
          type="email"
          required
          placeholder="name@company.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
          }}
        />
        <RoleSelect
          id={roleId}
          value={role}
          onChange={setRole}
          label="Role for the invited person"
        />
        <Button type="submit" disabled={invite.isPending || email.length === 0}>
          {invite.isPending ? "Inviting…" : "Invite"}
        </Button>
      </div>
    </form>
  );
}

function LinksSection({
  boardId,
  links,
  onChanged,
  onRevoke,
  onError,
}: {
  boardId: string;
  links: { id: string; role: ShareRole; createdAt: string; expiresAt: string | null }[];
  onChanged: () => Promise<void>;
  onRevoke: (id: string) => void;
  onError: (e: unknown) => void;
}) {
  const { api } = useAuth();
  const [role, setRole] = useState<ShareRole>("viewer");
  const [created, setCreated] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api.request(`/boards/${boardId}/share-links`, {
        method: "POST",
        body: { role },
        schema: createdShareLinkSchema,
      }),
    onSuccess: async (link) => {
      setCreated(`${window.location.origin}/s/${link.token}`);
      await onChanged();
    },
    onError,
  });
  return (
    <section aria-labelledby="links-heading" className="grid gap-2">
      <h3 id="links-heading" className="text-sm font-semibold">
        Share links
      </h3>
      <p className="text-xs text-muted-foreground">
        Anyone who signs in with a link gets its access. Revoke it any time.
      </p>
      <div className="flex gap-2">
        <RoleSelect value={role} onChange={setRole} label="Access for the new link" />
        <Button
          type="button"
          variant="outline"
          disabled={create.isPending}
          onClick={() => {
            create.mutate();
          }}
        >
          <Link2 aria-hidden="true" />
          Create link
        </Button>
      </div>
      {created && (
        <div role="status" className="grid gap-2 rounded-md border bg-muted/40 p-2 text-sm">
          <span>Copy this link now — it won't be shown again.</span>
          <div className="flex gap-2">
            <Input
              readOnly
              value={created}
              aria-label="New share link"
              onFocus={(e) => {
                e.currentTarget.select();
              }}
            />
            <CopyButton text={created} label="Copy" />
          </div>
        </div>
      )}
      <ul className="grid gap-1">
        {links.map((link) => (
          <li key={link.id} className="flex items-center justify-between text-sm">
            <span>
              {ROLE_LABELS[link.role]} link
              <span className="text-muted-foreground">
                {" "}
                · created {new Date(link.createdAt).toLocaleDateString()}
                {link.expiresAt ? `, expires ${new Date(link.expiresAt).toLocaleDateString()}` : ""}
              </span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onRevoke(link.id);
              }}
            >
              Revoke
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
