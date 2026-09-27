import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CopyButton } from "../ui/ShareDialog";
import { KeyWarning } from "./PrivateBadge";

/**
 * Shown right after a private board is created: the link with the key is the only way back
 * in, so the owner confirms they saved it before starting.
 */
export function SaveKeyDialog({
  open,
  link,
  onDone,
}: {
  open: boolean;
  link: string;
  onDone: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const checkId = useId();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closing counts as "done" only once they've confirmed.
        if (!next && saved) onDone();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Save this board&apos;s link</DialogTitle>
          <DialogDescription>
            This board is end-to-end encrypted. Its key was created in your browser and is part of
            the link below; our servers never see it.
          </DialogDescription>
        </DialogHeader>
        <KeyWarning />
        <div className="flex gap-2">
          <Input
            readOnly
            value={link}
            aria-label="Link with key"
            onFocus={(e) => {
              e.currentTarget.select();
            }}
          />
          <CopyButton text={link} label="Copy link" />
        </div>
        <label htmlFor={checkId} className="flex items-center gap-2 text-sm">
          <input
            id={checkId}
            type="checkbox"
            className="size-4 accent-primary"
            checked={saved}
            onChange={(e) => {
              setSaved(e.target.checked);
            }}
          />
          I&apos;ve saved the link somewhere safe
        </label>
        <div className="flex justify-end">
          <Button disabled={!saved} onClick={onDone}>
            Start drawing
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
