import { Link } from "react-router";
import { HealthStatus } from "@/components/HealthStatus";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function HomePage({ apiUrl }: { apiUrl: string }) {
  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center gap-8 px-6 py-16">
      <header className="space-y-3">
        <h1 className="text-4xl font-bold tracking-tight">Whiteboard.ai</h1>
        <p className="text-lg text-muted-foreground">
          A real-time collaborative whiteboard for system design, with an AI that reviews your
          architecture like a senior engineer.
        </p>
        <Button asChild size="lg">
          {/* /board/local redirects to a fresh board id. */}
          <Link to="/board/local">New board</Link>
        </Button>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>API connection</h2>
          </CardTitle>
          <CardDescription>
            Checks <code className="font-mono">{apiUrl}/healthz</code> from your browser.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <HealthStatus apiUrl={apiUrl} />
        </CardContent>
      </Card>
    </main>
  );
}
