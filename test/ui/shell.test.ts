import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AppShell } from '../../components/app-shell';
import { SignOutButton } from '../../components/sign-out-button';

test('the shell and its sign-out control are components', () => {
  assert.equal(typeof AppShell, 'function');
  assert.equal(typeof SignOutButton, 'function');
});

test('the stylesheet imports tailwind', async () => {
  const css = await readFile(new URL('../../app/globals.css', import.meta.url), 'utf8');
  assert.ok(css.includes('@import "tailwindcss"'), 'globals.css must import tailwindcss');
});

test('the layout imports the stylesheet', async () => {
  // Without this import the whole app renders unstyled, and nothing else in
  // the suite would notice.
  const layout = await readFile(new URL('../../app/layout.tsx', import.meta.url), 'utf8');
  assert.ok(layout.includes("./globals.css"), 'layout.tsx must import ./globals.css');
});

test('postcss loads the tailwind v4 plugin and no config file exists', async () => {
  const postcss = await readFile(new URL('../../postcss.config.mjs', import.meta.url), 'utf8');
  assert.ok(postcss.includes('@tailwindcss/postcss'));
  // v4 is CSS-first. A tailwind.config.js here would be silently ignored,
  // which is worse than absent: someone would edit it and expect an effect.
  // Asserted via the error code rather than assert.rejects with a bare string,
  // which node reads as the message parameter and so checks nothing.
  const present = await readFile(new URL('../../tailwind.config.js', import.meta.url), 'utf8')
    .then(() => true)
    .catch(() => false);
  assert.equal(present, false, 'there must be no tailwind.config.js');
});
