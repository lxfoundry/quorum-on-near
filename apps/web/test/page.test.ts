import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const folder = new URL('../', import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, folder), 'utf8');
const html = read('index.html');
const app = read('app.js');
const css = read('style.css');
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

  it('does not make the status line a live region, which would announce its update every 2 seconds', () => {
    const tag = /<[^>]*\bid="status"[^>]*>/.exec(html)?.[0] ?? '';
    expect(tag).not.toBe('');
    expect(tag).not.toMatch(/aria-live|role=/);
  });

  it('has a visually hidden live region for the failures and the recoveries that app.js announces', () => {
    const tag = /<[^>]*\bid="announcement"[^>]*>/.exec(html)?.[0] ?? '';
    expect(tag).toMatch(/role="status"/);
    expect(tag).toMatch(/aria-live="polite"/);
    expect(tag).toMatch(/class="visually-hidden"/);
    expect(css).toMatch(/\.visually-hidden\s*\{[^}]*clip-path:[^}]*\}/);
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

describe('style.css', () => {
  // A notice or a failure can hold a 64-character implicit account id, which has no break of its own
  // and would otherwise widen the whole page on a narrow screen.
  it.each(['.status', '.empty', '.account', '.footer'])('breaks a long word inside %s', (selector) => {
    const bodies = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((rule) => (rule[1] ?? '').split(',').some((name) => name.trim() === selector))
      .map((rule) => rule[2] ?? '');
    expect(bodies.some((body) => /overflow-wrap:\s*anywhere/.test(body)), selector).toBe(true);
  });
});

describe('the demo controls', () => {
  it('are hidden in the markup until app.js shows them for a gateway whose demo is on', () => {
    expect(html).toMatch(/<section id="demo" class="demo" aria-label="Demo runs" hidden>/);
  });

  it('label the two buttons as the spec words them', () => {
    expect(html).toContain('<button id="demo-fills" type="button">Start a pool that fills</button>');
    expect(html).toContain('<button id="demo-fails" type="button">Start a pool that fails</button>');
  });

  it("keep the demo line apart from the page's status line", () => {
    expect(html).toContain('<p id="demo-line" class="demo-line" role="status" aria-live="polite"></p>');
    expect(html).toContain('<p id="status" class="status">Loading…</p>');
  });

  it('remove ?pool= from the URL before sending the request a button sends', () => {
    const removed = app.indexOf("history.replaceState(null, '', withoutPoolParam(location.href))");
    const sent = app.indexOf('fetch(request.url');
    expect(removed).toBeGreaterThan(-1);
    expect(sent).toBeGreaterThan(removed);
    expect(app).toContain('const request = demoRequest(scenario);');
  });

  it('read GET /demo only when the gateway says its demo is on', () => {
    expect(app.split("getJson('/demo')")).toHaveLength(2);
    expect(app).toMatch(/async function refreshDemo\(config\) \{\s*if \(!config\.demo\) \{[^}]*return;\s*\}[^]*?parseDemoStatus\(await getJson\('\/demo'\)\)/);
  });
});
