import type { Scenario } from '../scenario/steps.ts';
import { control } from './control.ts';
import { edge } from './edge.ts';
import { environment } from './environment.ts';
import { lifecycle } from './lifecycle.ts';
import { observe } from './observe.ts';
import { platform } from './platform.ts';
import { recovery } from './recovery.ts';
import { trust } from './trust.ts';

export const scenarios: Scenario[] = [
  ...lifecycle,
  ...control,
  ...recovery,
  ...environment,
  ...trust,
  ...platform,
  ...edge,
  ...observe,
];
