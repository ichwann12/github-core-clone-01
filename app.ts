// The forge's HTTP surface: one Store, four handlers, one server.
// main.ts owns the entry <-> env lifecycle and stays as it is; this file is the server.
//
// Routing order: /healthz (the env's boot check) first, then the four surfaces, then a
// JSON 404 for everything else. Each handler answers only its own paths and returns false
// otherwise, so the next handler gets a clean shot at the request.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './src/git-protocol.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest } from './src/rest.ts';
import { Store } from './src/store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  const auth = process.env.MAKEFUN_SHOP_TOKEN !== '' ? process.env.MAKEFUN_SHOP_TOKEN : undefined;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}. No auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (await handleGraphQL(req, res, store, auth)) return;
        if (await handleMcp(req, res, store, auth)) return;
        if (await handleRest(req, res, store, auth)) return;
        if (await handleGit(req, res, store, auth)) return;

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch {
        // A handler that throws must not take the server down: answer JSON and stay up.
        try {
          sendJson(res, 500, { message: 'Internal Server Error' });
        } catch {
          // The socket is already gone; nothing left to do.
        }
      }
    })();
  });
}
