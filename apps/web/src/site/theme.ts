/**
 * Dark mode for the public site: the visitor's choice (localStorage) or, without one, the
 * system setting. App pages (dashboard, board) stay light for now; the site layout removes the
 * class when you leave the public pages.
 */
export type ThemeChoice = "light" | "dark";

export const THEME_KEY = "whiteboard.theme";

/**
 * Runs in <head> of every prerendered page before first paint, so a dark-mode visitor never
 * sees a white flash. Kept tiny and dependency-free; mirrors `prefersDark` below.
 */
export const THEME_SCRIPT = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}`;

export function storedTheme(): ThemeChoice | null {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

export function prefersDark(): boolean {
  const stored = storedTheme();
  if (stored) return stored === "dark";
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyTheme(dark: boolean): void {
  document.documentElement.classList.toggle("dark", dark);
}

export function saveTheme(choice: ThemeChoice): void {
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Not remembered; the page still switches.
  }
  applyTheme(choice === "dark");
}
