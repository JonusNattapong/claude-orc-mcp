---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# claude-orc (claude-peers fork)

Peer discovery and messaging MCP channel for Claude Code instances. This fork adds agent roles, broadcast, and Windows compatibility on top of the original `claude-peers`.

## Architecture

- `broker.ts` — Singleton HTTP daemon on localhost:7899 + SQLite. Auto-launched by the MCP server. Endpoints: `/register`, `/heartbeat`, `/set-summary`, `/set-role`, `/list-peers`, `/list-peers-by-role`, `/send-message`, `/broadcast`, `/poll-messages`, `/unregister`, `/health`.
- `server.ts` — MCP stdio server, one per Claude Code instance. Connects to broker, exposes tools, pushes channel notifications every 2s. Tools: `list_peers`, `list_peers_by_role`, `send_message`, `broadcast_message`, `set_summary`, `set_role`, `check_messages`.
- `shared/types.ts` — Shared TypeScript types for broker API and the `PeerRole` enum (`boss` | `worker` | `reviewer` | `any`).
- `shared/platform.ts` — Cross-platform PID liveness helper (`isProcessAlive`). Replaces the original `process.kill(pid, 0)` pattern.
- `shared/summarize.ts` — Auto-summary generation via gpt-5.4-nano.
- `cli.ts` — CLI utility for inspecting broker state. Commands: `status`, `peers`, `peers-by-role`, `send`, `broadcast`, `set-role`, `kill-broker`.
- `tests/` — `bun:test` integration tests covering broker endpoints, polling, liveness, schema migration, and cross-platform behavior.

## Running

```bash
# Start Claude Code with the channel:
claude --dangerously-load-development-channels server:claude-peers

# Or just add to .mcp.json and use as regular MCP (no channel push, but tools work):
# { "claude-peers": { "command": "bun", "args": ["./server.ts"] } }

# CLI:
bun cli.ts status
bun cli.ts peers
bun cli.ts peers-by-role worker
bun cli.ts send <peer-id> <message>
bun cli.ts broadcast <message> --roles worker
bun cli.ts set-role <peer-id> worker
bun cli.ts kill-broker
```

## Tests

```bash
bun test                              # run all
bun test tests/broker.test.ts         # single file
bunx tsc --noEmit                     # typecheck
```

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
