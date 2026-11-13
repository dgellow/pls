/**
 * Network layer in front of the simulated GitHub server.
 *
 * A TCP proxy between clients and the HTTP server, so scenarios can produce
 * transport failures that an HTTP handler cannot: a connection closed with no
 * response, a host that accepts connections and never answers, a host that is
 * down, and added latency.
 */

export class Network {
  private listener: Deno.Listener | null = null;
  /** upstream local port → client connection */
  private clients = new Map<number, Deno.TcpConn>();
  private open = new Set<Deno.TcpConn>();
  port = 0;
  /** Refuse service: connections are closed immediately. */
  down = false;
  /** Accept connections and never forward anything. */
  blackhole = false;
  /** Delay added to every chunk sent to the client. */
  latencyMs = 0;

  constructor(private upstreamPort: number) {}

  start(): void {
    this.listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    this.port = (this.listener.addr as Deno.NetAddr).port;
    this.acceptLoop();
  }

  private async acceptLoop(): Promise<void> {
    const listener = this.listener!;
    while (true) {
      let client: Deno.TcpConn;
      try {
        client = await listener.accept() as Deno.TcpConn;
      } catch {
        return; // listener closed
      }
      this.serve(client).catch(() => {});
    }
  }

  private async serve(client: Deno.TcpConn): Promise<void> {
    this.open.add(client);
    if (this.down) {
      this.closeQuietly(client);
      return;
    }
    if (this.blackhole) return; // keep the socket open, say nothing
    let upstream: Deno.TcpConn;
    try {
      upstream = await Deno.connect({ hostname: '127.0.0.1', port: this.upstreamPort });
    } catch {
      this.closeQuietly(client);
      return;
    }
    this.open.add(upstream);
    const key = (upstream.localAddr as Deno.NetAddr).port;
    this.clients.set(key, client);
    const toUpstream = this.pump(client, upstream, false);
    const toClient = this.pump(upstream, client, true);
    await Promise.race([toUpstream, toClient]);
    this.closeQuietly(client);
    this.closeQuietly(upstream);
    this.clients.delete(key);
  }

  private async pump(from: Deno.TcpConn, to: Deno.TcpConn, delayed: boolean): Promise<void> {
    const buf = new Uint8Array(64 * 1024);
    try {
      while (true) {
        const n = await from.read(buf);
        if (n === null) return;
        if (delayed && this.latencyMs > 0) {
          await new Promise((r) => setTimeout(r, this.latencyMs));
        }
        let written = 0;
        while (written < n) written += await to.write(buf.subarray(written, n));
      }
    } catch {
      // either side went away
    }
  }

  /** Abort the client connection whose request the HTTP server sees from `upstreamPort`. */
  kill(upstreamPort: number): void {
    const client = this.clients.get(upstreamPort);
    if (client) this.closeQuietly(client);
  }

  private closeQuietly(conn: Deno.TcpConn): void {
    this.open.delete(conn);
    try {
      conn.close();
    } catch {
      // already closed
    }
  }

  close(): void {
    try {
      this.listener?.close();
    } catch {
      // already closed
    }
    for (const conn of [...this.open]) this.closeQuietly(conn);
  }
}
