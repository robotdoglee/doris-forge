// Git smart HTTP — placeholder until the protocol lands; answers a plain 404 for now.

import type { Forge } from './store.ts';
import type { Req, Res } from './http.ts';

export async function handleGit(_forge: Forge, _req: Req, res: Res, _owner: string, _repoName: string, _rest: string[]): Promise<void> {
  res.raw(404, Buffer.from('repository not found\n', 'utf8'), 'text/plain; charset=utf-8');
}
