import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The server's standard output carries the MCP stream, so nothing the server runs from this
 * repository may write to it: neither its own sources nor those of the packages it imports.
 */

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const FOLDERS = ['apps/mcp/src', 'packages/buyer/src', 'packages/protocol/src'];
/** The stream itself, and every console method that prints to standard output. */
const WRITES_TO_STDOUT =
  /\bprocess\.stdout\b|\bconsole\.(?:log|info|debug|dir|dirxml|table|group|groupCollapsed|count|timeLog|timeEnd)\b/;

async function sourceFiles(folder: string): Promise<string[]> {
  const names = await readdir(folder, { recursive: true });
  return names.filter((name) => name.endsWith('.ts')).map((name) => join(folder, name));
}

describe('standard output', () => {
  it.each(FOLDERS)('is never written by the sources in %s', async (folder) => {
    const files = await sourceFiles(join(ROOT, folder));
    expect(files.length).toBeGreaterThan(0);
    const writes: string[] = [];
    for (const file of files) {
      const lines = (await readFile(file, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        if (WRITES_TO_STDOUT.test(line)) writes.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(writes).toEqual([]);
  });
});
