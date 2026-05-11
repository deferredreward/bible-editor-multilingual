import type { Env } from "./index";

export class ChapterRoom implements DurableObject {
  private clients = new Set<WebSocket>();

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {
    void this.state;
    void this.env;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    server.accept();
    this.clients.add(server);
    server.addEventListener("close", () => this.clients.delete(server));
    server.addEventListener("message", (event) => {
      for (const c of this.clients) {
        if (c !== server && c.readyState === WebSocket.READY_STATE_OPEN) {
          c.send(event.data);
        }
      }
    });
    return new Response(null, { status: 101, webSocket: client });
  }
}
