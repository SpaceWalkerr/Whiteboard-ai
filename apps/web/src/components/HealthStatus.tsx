import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { fetchHealth } from "@/lib/api";

export function HealthStatus({ apiUrl }: { apiUrl: string }) {
  const health = useQuery({
    queryKey: ["health", apiUrl],
    queryFn: ({ signal }) => fetchHealth(apiUrl, signal),
    retry: false,
  });

  return (
    <div className="flex flex-wrap items-center gap-3">
      <p role="status" aria-live="polite" className="flex items-center gap-2 text-sm font-medium">
        <span
          aria-hidden="true"
          className={
            health.isSuccess
              ? "size-2.5 rounded-full bg-success"
              : health.isError
                ? "size-2.5 rounded-full bg-destructive"
                : "size-2.5 animate-pulse rounded-full bg-muted-foreground"
          }
        />
        {health.isPending && "Server: checking…"}
        {health.isSuccess && `Server: ${health.data.status}`}
        {health.isError && `Server: unreachable (${health.error.message})`}
      </p>
      {health.isError && (
        <Button variant="outline" size="sm" onClick={() => void health.refetch()}>
          Retry
        </Button>
      )}
    </div>
  );
}
