import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envNumber, envInt } from '../../lib/env';

function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test('an unset or empty variable falls back', () => {
  withEnv('PROBE_N', undefined, () => {
    assert.equal(envNumber('PROBE_N', 0.75), 0.75);
    assert.equal(envInt('PROBE_N', 8000), 8000);
  });
  withEnv('PROBE_N', '', () => {
    assert.equal(envNumber('PROBE_N', 0.75), 0.75);
    assert.equal(envInt('PROBE_N', 8000), 8000);
  });
});

test('envNumber keeps a fractional value — this is the trap the split exists for', () => {
  // A single helper parsing with parseInt would give 0 here, every score would
  // clear a floor of zero, and every lookup would be marked resolved.
  withEnv('PROBE_N', '0.75', () => {
    assert.equal(envNumber('PROBE_N', 1), 0.75);
  });
  withEnv('PROBE_N', '0.9', () => {
    assert.equal(envNumber('PROBE_N', 1), 0.9);
  });
});

test('envInt truncates rather than returning NaN for a fractional value', () => {
  withEnv('PROBE_N', '6.9', () => {
    assert.equal(envInt('PROBE_N', 1), 6);
  });
});

test('a malformed value falls back rather than poisoning arithmetic', () => {
  for (const bad of ['abc', 'NaN', 'Infinity', '-Infinity']) {
    withEnv('PROBE_N', bad, () => {
      assert.equal(envNumber('PROBE_N', 0.75), 0.75, bad);
      assert.equal(envInt('PROBE_N', 8000), 8000, bad);
    });
  }
});

test('a negative or zero value is passed through, not silently corrected', () => {
  // Whether zero is sensible is the caller's business; the parser's job is to
  // report what was configured.
  withEnv('PROBE_N', '0', () => {
    assert.equal(envNumber('PROBE_N', 5), 0);
    assert.equal(envInt('PROBE_N', 5), 0);
  });
  withEnv('PROBE_N', '-3', () => {
    assert.equal(envInt('PROBE_N', 5), -3);
  });
});
