import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { quoteWindows, buildWindowsCommandLine } from '../src/host/stdio.ts';

describe('quoteWindows', () => {
  it('leaves plain tokens alone', () => {
    assert.equal(quoteWindows('uvx'), 'uvx');
    assert.equal(quoteWindows('--from'), '--from');
    assert.equal(quoteWindows('@scope/pkg@1.0'), '@scope/pkg@1.0');
  });
  it('escapes version ranges so cmd does not redirect', () => {
    assert.equal(quoteWindows('mcp>=1.2.0,<2.0.0'), '^"mcp^>=1.2.0^,^<2.0.0^"');
  });
  it('escapes metacharacters and quotes', () => {
    const q = quoteWindows('a & b | "c"');
    assert.ok(!/(^|[^^])[&|<>]/.test(q), q);
    assert.ok(!/(^|[^^])"/.test(q), q);
  });
  it('handles empty, spaces and parentheses', () => {
    assert.equal(quoteWindows(''), '^"^"');
    assert.equal(quoteWindows('C:\\\\Program Files (x86)\\\\x.exe'), '^"C:\\\\Program^ Files^ ^(x86^)\\\\x.exe^"');
  });
  it('builds a full line', () => {
    assert.equal(buildWindowsCommandLine('npx', ['-y', 'a|b']), 'npx -y ^"a^|b^"');
  });
});
