import { Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { saveTheme } from "../theme";

const isDark = () => document.documentElement.classList.contains("dark");

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => {
    observer.disconnect();
  };
}

/**
 * The icon follows the `dark` class (set before first paint), so the prerendered HTML is right
 * for every visitor; the pressed state is only known in the browser, so it is null on the server
 * and during hydration.
 */
export function ThemeToggle() {
  const dark = useSyncExternalStore(subscribe, isDark, () => null);

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Dark mode"
      aria-pressed={dark ?? undefined}
      onClick={() => {
        saveTheme(isDark() ? "light" : "dark");
      }}
    >
      <Moon className="dark:hidden" aria-hidden="true" />
      <Sun className="hidden dark:block" aria-hidden="true" />
    </Button>
  );
}
