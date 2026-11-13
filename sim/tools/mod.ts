import { changesets } from './changesets.ts';
import { pls } from './pls.ts';
import { releasePlease } from './release_please.ts';
import { semanticRelease } from './semantic_release.ts';
import type { Tool } from './tool.ts';

export const tools: Tool[] = [pls, releasePlease, changesets, semanticRelease];
