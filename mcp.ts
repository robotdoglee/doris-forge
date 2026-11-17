// MCP endpoint — placeholder until the tools land.

import type { Forge } from './store.ts';
import type { Req, Res } from './http.ts';

export async function handleMcp(_forge: Forge, _req: Req, res: Res): Promise<void> {
  res.json(404, { message: 'Not Found' });
}
