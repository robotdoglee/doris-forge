// GraphQL v4 — placeholder until the executor lands.

import type { Forge } from './store.ts';
import type { Req, Res } from './http.ts';

export async function handleGraphql(_forge: Forge, _req: Req, res: Res): Promise<void> {
  res.json(404, { message: 'Not Found' });
}
