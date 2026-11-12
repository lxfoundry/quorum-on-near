import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const folder = new URL('../', import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, folder), 'utf8');
const html = read('index.html');
const app = read('app.js');
const scripts = readdirSync(folder).filter((name) => name.endsWith('.js'));

describe('index.html', () => {
  it('shows the banner, word for word', () => {
    expect(html).toContain(
      'The provider is simulated, and prices are scaled down 10,000 times. The money flow is real: USDC on NEAR testnet.',
    );
  });

  it('loads app.js as a module and style.css as its stylesheet', () => {
    expect(html).toMatch(/<script type="module" src="app\.js"><\/script>/);
    expect(html).toMatch(/<link rel="stylesheet" href="style\.css">/);
  });

  it('declares its icon inline, so the browser does not ask the gateway for /favicon.ico, which it answers 404', () => {
    expect(html).toMatch(/<link rel="icon" href="data:,">/);
  });

  it('has every element app.js looks up', () => {
    const ids = [...app.matchAll(/element\('([^']+)'/g)].map((match) => match[1]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(html, `#${id}`).toContain(`id="${id}"`);
  });
});

describe('the page scripts', () => {
  it('are app.js and totals.js', () => {
    expect(scripts.sort()).toEqual(['app.js', 'totals.js']);
  });

  it.each(scripts)('%s imports only files of this folder, so the page needs no build step', (name) => {
    const specifiers = [...read(name).matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1] ?? '');
    for (const specifier of specifiers) {
      expect(specifier).toMatch(/^\.\/[\w-]+\.js$/);
      expect(existsSync(new URL(specifier, folder)), specifier).toBe(true);
    }
  });

  it.each(scripts)('%s never writes HTML from a string', (name) => {
    expect(read(name)).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});
