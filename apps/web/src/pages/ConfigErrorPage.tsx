export function ConfigErrorPage({ message }: { message: string }) {
  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center gap-4 px-6">
      <h1 className="text-3xl font-bold tracking-tight">Configuration error</h1>
      <p className="text-muted-foreground">
        This build of the web app is missing required settings.
      </p>
      <pre className="overflow-x-auto rounded-md bg-muted p-4 text-sm whitespace-pre-wrap">
        {message}
      </pre>
    </main>
  );
}
