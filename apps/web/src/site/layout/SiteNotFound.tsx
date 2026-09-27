import { Link } from "react-router";
import { Button } from "@/components/ui/button";

/** Not-found content inside the site layout (which already provides <main>). */
export function SiteNotFound() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-24 sm:px-6">
      <h1 className="text-3xl font-bold tracking-tight">Page not found</h1>
      <p className="text-muted-foreground">The page you were looking for doesn’t exist.</p>
      <div>
        <Button asChild>
          <Link to="/">Go home</Link>
        </Button>
      </div>
    </div>
  );
}
