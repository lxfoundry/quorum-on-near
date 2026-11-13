import { describe, expect, it } from 'vitest';
import * as entry from '@quorum-on-near/buyer';
import * as buyer from '../src/buyer.ts';
import * as chain from '../src/chain.ts';
import * as errors from '../src/errors.ts';
import * as gateway from '../src/gateway.ts';
import * as keyFiles from '../src/key-files.ts';
import * as settings from '../src/settings.ts';
import * as spendFile from '../src/spend-file.ts';

describe('@quorum-on-near/buyer', () => {
  it('exports, from the package entry, everything each of its modules exports', () => {
    const modules: Record<string, unknown>[] = [settings, keyFiles, spendFile, gateway, chain, buyer, errors];
    const exported = modules.flatMap((module) => Object.keys(module));
    expect(Object.keys(entry).sort()).toEqual([...new Set(exported)].sort());
    for (const module of modules) {
      for (const [name, value] of Object.entries(module)) expect(entry[name as keyof typeof entry]).toBe(value);
    }
  });
});
