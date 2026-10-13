/**
 * dsh-mcp-master — Client half.
 *
 * Registers the composer MCP picker into `conversation.input.right` (the
 * composer row's trailing controls, immediately before the model selector),
 * its `mcpMaster` dictionaries (following Settings → General → Language), and
 * its stylesheet.
 */

import { NS, en, zh } from './locale.ts';
import { McpPicker } from './McpPicker.tsx';
import { CSS, STYLE_ID } from './styles.ts';

type Cleanup = () => unknown;

/** The Client services this plugin uses (structural subset). */
interface ClientContext {
  effect(execute: () => Cleanup | void, label?: string): unknown;
  slots: {
    inject(name: string, callback: () => unknown): unknown;
    register(options: { name: string; id: string; order?: number; locale?: string }, component: unknown): unknown;
  };
  locale: {
    register(ns: string, dictionaries: Record<string, Record<string, string>>): Cleanup;
  };
}

export const inject = ['slots', 'locale'];

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mcp-master: dictionaries');

  ctx.effect(() => {
    if (typeof document === 'undefined') return;
    const tag = document.createElement('style');
    tag.dataset['plugin'] = 'dsh-mcp-master';
    tag.dataset['pluginCss'] = STYLE_ID;
    tag.textContent = CSS;
    document.head.appendChild(tag);
    return () => tag.remove();
  }, 'mcp-master: styles');

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'mcp-master',
    order: 10,
    locale: NS,
  }, McpPicker));
}
