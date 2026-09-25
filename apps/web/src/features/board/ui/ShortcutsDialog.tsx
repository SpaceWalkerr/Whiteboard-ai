import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { formatKey, SHORTCUTS, type Shortcut } from "../keyboard/shortcuts";

const GROUPS: Shortcut["group"][] = ["Tools", "Edit", "Arrange", "View"];

export function ShortcutsDialog({
  open,
  onOpenChange,
  mac,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mac: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Everything on the board can be done from the keyboard.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-6 sm:grid-cols-2">
          {GROUPS.map((group) => (
            <section key={group} aria-labelledby={`shortcuts-${group}`}>
              <h3 id={`shortcuts-${group}`} className="mb-2 text-sm font-semibold">
                {group}
              </h3>
              <dl className="grid gap-1.5 text-sm">
                {SHORTCUTS.filter((s) => s.group === group).map((s) => (
                  <div key={s.description} className="flex items-center justify-between gap-4">
                    <dt className="text-muted-foreground">{s.description}</dt>
                    <dd className="flex shrink-0 gap-1">
                      {s.keys.map((k) => (
                        <Kbd key={k}>{formatKey(k, mac)}</Kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
