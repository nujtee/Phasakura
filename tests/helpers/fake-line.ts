/**
 * Fake LINE Messaging API (push / reply / bot info / quota) for tests and the e2e server.
 * Behaves like LINE for retry keys: a key accepted once answers 409 afterwards.
 */
export interface FakePush {
  to: string;
  texts: string[];
  retryKey: string | null;
  authorization: string | null;
}

export class FakeLine {
  readonly pushes: FakePush[] = [];
  readonly replies: { replyToken: string; texts: string[] }[] = [];
  /** Status codes for the next push calls (default 200). "network" throws. */
  readonly nextPush: (number | "network")[] = [];
  private readonly accepted = new Set<string>();
  bot = { basicId: "@phasakura", displayName: "Phasakura Test OA" };
  botStatus = 200;
  quota = { limit: 300, used: 12 };

  reset(): void {
    this.pushes.length = 0;
    this.replies.length = 0;
    this.nextPush.length = 0;
  }

  readonly fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    if (url.hostname !== "api.line.me") throw new Error(`unexpected host ${url.hostname}`);
    const headers = new Headers(init.headers);
    const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...extra } });
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const texts = ((body.messages as { text: string }[] | undefined) ?? []).map((m) => m.text);

    switch (url.pathname) {
      case "/v2/bot/message/push": {
        const key = headers.get("X-Line-Retry-Key");
        if (key && this.accepted.has(key)) return json({ message: "The retry key is already accepted" }, 409, { "x-line-accepted-request-id": "req-accepted" });
        const status = this.nextPush.shift() ?? 200;
        if (status === "network") throw new TypeError("fetch failed");
        if (status === 200) {
          if (key) this.accepted.add(key);
          this.pushes.push({ to: String(body.to), texts, retryKey: key, authorization: headers.get("Authorization") });
          return json({ sentMessages: texts.map((_, i) => ({ id: String(i) })) });
        }
        if (status === 202) {
          // LINE accepted it but our side "timed out": the key is now used.
          if (key) this.accepted.add(key);
          this.pushes.push({ to: String(body.to), texts, retryKey: key, authorization: headers.get("Authorization") });
          throw new DOMException("The operation timed out.", "TimeoutError");
        }
        return json({ message: status === 400 ? "The property, 'to', in the request body is invalid" : `error ${status}` }, status, status === 429 ? { "Retry-After": "120" } : {});
      }
      case "/v2/bot/message/reply":
        this.replies.push({ replyToken: String(body.replyToken), texts });
        return json({});
      case "/v2/bot/info":
        return this.botStatus === 200 ? json({ userId: "Ubot", basicId: this.bot.basicId, displayName: this.bot.displayName, chatMode: "bot" }) : json({ message: "Authentication failed" }, this.botStatus);
      case "/v2/bot/message/quota":
        return json({ type: "limited", value: this.quota.limit });
      case "/v2/bot/message/quota/consumption":
        return json({ totalUsage: this.quota.used });
      default:
        return json({ message: "not found" }, 404);
    }
  };
}
