import { Link, NavLink } from "react-router";
import { useAuth } from "@/auth/authContext";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "./ThemeToggle";

const NAV = [
  { to: "/templates", label: "Templates" },
  { to: "/docs", label: "Docs" },
  { to: "/pricing", label: "Pricing" },
] as const;

export function SiteHeader() {
  // "loading" renders like signed out, exactly as the prerendered HTML does.
  const { status } = useAuth();
  return (
    <header className="border-b">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
        <Link to="/" className="rounded-sm text-lg font-semibold tracking-tight">
          Whiteboard.ai
        </Link>
        <nav aria-label="Main" className="order-3 w-full sm:order-none sm:w-auto">
          <ul className="flex gap-5 text-sm">
            {NAV.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  className={({ isActive }) =>
                    cn(
                      "rounded-sm py-1 text-muted-foreground hover:text-foreground",
                      isActive && "font-medium text-foreground",
                    )
                  }
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          {status === "signedIn" ? (
            <Button asChild size="sm">
              <Link to="/app">Open your boards</Link>
            </Button>
          ) : (
            <>
              {/* Phones: "Start free" alone (it opens the same page) keeps the header one row. */}
              <Button asChild size="sm" variant="ghost" className="hidden sm:inline-flex">
                <Link to="/sign-in">Sign in</Link>
              </Button>
              <Button asChild size="sm">
                <Link to="/sign-in">Start free</Link>
              </Button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
