import { createConnection, createServer, type Server, type Socket } from "node:net";

/**
 * A TCP load balancer for tests: each new connection goes to the next backend in turn (no
 * stickiness), skipping backends that refuse connections — like Render's load balancer in
 * front of several instances, or nginx in docker-compose.scale.yml.
 */
export async function startRoundRobinProxy(backends: number[]): Promise<{
  port: number;
  /** Backend port each accepted connection was sent to, in order. */
  routed: number[];
  close: () => Promise<void>;
}> {
  let next = 0;
  const routed: number[] = [];
  const sockets = new Set<Socket>();

  const connect = (client: Socket, attempt: number) => {
    if (attempt >= backends.length) {
      client.destroy();
      return;
    }
    const port = backends[next % backends.length] ?? 0;
    next += 1;
    const upstream = createConnection({ host: "127.0.0.1", port });
    let established = false;
    sockets.add(upstream);
    upstream.on("error", () => {
      sockets.delete(upstream);
      // Refused (instance down): try the next one. Once established, just hang up.
      if (!established) connect(client, attempt + 1);
      else client.destroy();
    });
    upstream.once("connect", () => {
      established = true;
      routed.push(port);
      client.pipe(upstream).pipe(client);
      client.resume();
      upstream.on("close", () => client.destroy());
      client.on("close", () => upstream.destroy());
    });
  };

  const server: Server = createServer((client) => {
    sockets.add(client);
    client.pause();
    client.on("error", () => undefined);
    client.on("close", () => sockets.delete(client));
    connect(client, 0);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    port: address.port,
    routed,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    },
  };
}
