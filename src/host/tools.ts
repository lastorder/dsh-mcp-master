/**
 * MCP tools → DSH ToolDefinitions (same naming and result shape as the
 * built-in @deepseek-ai/dsh-mcp-client) plus generation-stable registration
 * syncing, so a `tools/list_changed` only touches tools that really changed.
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  AttachmentStore, ContentBlock, Disposer, ModelInfoRegistry, ToolDefinition, ToolExecution,
} from './dsh.ts';
import type { McpTool } from './jsonrpc.ts';
import { sanitizeInputSchema } from './schema.ts';

const MAX_PUBLIC_NAME_LENGTH = 64;
const HASH_LENGTH = 12;
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** `mcp__<server>__<tool>` normalized to `[A-Za-z0-9_-]{1,64}`, with a hash on lossy changes. */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_');
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH);
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}

type McpBlock = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function imageDiagnostic(block: McpBlock, reason: string): string {
  return `[image unavailable: ${typeof block['mimeType'] === 'string' ? block['mimeType'] : 'unknown media type'}; ${reason}]`;
}

type ImageProjector = (block: McpBlock, index: number) => ContentBlock;

const textPlaceholder: ImageProjector = (block) => ({ type: 'text', text: imageDiagnostic(block, 'not admitted to model context') });

/** Ordered MCP content → DSH content blocks (text runs coalesced). */
export function projectContent(content: unknown, toolName: string, image: ImageProjector = textPlaceholder): ContentBlock[] {
  const projected: ContentBlock[] = [];
  const text: string[] = [];
  const flush = (): void => {
    if (text.length > 0) projected.push({ type: 'text', text: text.splice(0).join('\n') });
  };
  for (const [index, block] of (Array.isArray(content) ? content : []).entries()) {
    if (!isRecord(block)) { text.push('[unsupported MCP content block]'); continue; }
    switch (block['type']) {
      case 'text':
        if (typeof block['text'] === 'string') text.push(block['text']);
        break;
      case 'image':
        flush();
        projected.push(image(block, index));
        break;
      case 'resource_link':
        text.push(typeof block['uri'] === 'string' ? `Resource link: ${String(block['name'] ?? block['uri'])} (${block['uri']})` : '[resource link without uri]');
        break;
      case 'resource': {
        const res = isRecord(block['resource']) ? block['resource'] : {};
        if (typeof res['text'] === 'string') text.push(`Resource ${String(res['uri'] ?? '')}:\n${res['text']}`);
        else text.push(`[embedded resource ${String(res['uri'] ?? '')} (${String(res['mimeType'] ?? 'binary')}) not shown]`);
        break;
      }
      case 'audio':
        text.push(`[audio result (${String(block['mimeType'] ?? 'unknown media type')}) not shown]`);
        break;
      default:
        text.push(`[unsupported MCP content type: ${String(block['type'])}]`);
    }
  }
  flush();
  return projected.length > 0 ? projected : [{ type: 'text', text: `(${toolName} returned no content)` }];
}

function extractText(content: unknown, toolName: string): string {
  return projectContent(content, toolName).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

function decodeImage(block: McpBlock): { data: Buffer; mediaType: string } {
  const mediaType = block['mimeType'];
  const data = block['data'];
  if (typeof mediaType !== 'string' || !IMAGE_MEDIA_TYPES.has(mediaType)) throw new Error('the media type is not PNG, JPEG, WebP, or GIF');
  if (typeof data !== 'string' || !CANONICAL_BASE64.test(data)) throw new Error('the image data is not canonical base64');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data) throw new Error('the image data is not canonical base64');
  return { data: bytes, mediaType };
}

/** Optional Host services used for durable image results. */
export interface ToolServices {
  get(name: 'attachments'): AttachmentStore | undefined;
  get(name: 'llm'): ModelInfoRegistry | undefined;
}

/** Store images durably when the routed model accepts image input; otherwise text placeholders. */
async function prepareImageProjection(services: ToolServices, exec: ToolExecution, content: unknown[], toolName: string): Promise<ContentBlock[]> {
  const decoded: Array<{ data: Buffer; mediaType: string }> = [];
  const indexes: number[] = [];
  const invalid = new Map<number, string>();
  for (const [index, block] of content.entries()) {
    if (!isRecord(block) || block['type'] !== 'image') continue;
    indexes.push(index);
    try { decoded.push(decodeImage(block)); } catch (error) { invalid.set(index, (error as Error).message); }
  }
  if (invalid.size > 0) {
    return projectContent(content, toolName, (block, index) => ({ type: 'text', text: imageDiagnostic(block, invalid.get(index) ?? 'another image was invalid') }));
  }
  try {
    const attachments = services.get('attachments');
    const llm = services.get('llm');
    if (!attachments || !llm) throw new Error('no attachment store or model registry is mounted');
    const routed = exec.agent?.session.requestHeader?.()?.config;
    const provider = routed?.provider ?? exec.agent?.options?.provider;
    const model = routed?.model ?? exec.agent?.options?.model;
    if (!provider || !model) throw new Error('the current model route is unknown');
    const info = await llm.resolveModelInfo(provider, model, exec.signal);
    if (!info?.inputModalities?.includes('image')) throw new Error(`model "${model}" does not accept images`);
    const refs = attachments.saveImages
      ? await attachments.saveImages(decoded)
      : await Promise.all(decoded.map((d) => attachments.saveImage?.(d)));
    const byIndex = new Map(indexes.map((index, i) => [index, refs[i]]));
    return projectContent(content, toolName, (block, index) => {
      const attachment = byIndex.get(index);
      return attachment ? { type: 'image', attachment } : { type: 'text', text: imageDiagnostic(block, 'storage rejected the image') };
    });
  } catch (error) {
    const reason = String((error as Error)?.message ?? error);
    return projectContent(content, toolName, (block) => ({ type: 'text', text: imageDiagnostic(block, reason) }));
  }
}

const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    content: { type: 'array', items: {} },
    structuredContent: {},
  },
  required: ['content'],
  additionalProperties: false,
});

/** Raw `tools/call` result as the MCP server returns it. */
export interface CallToolResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface ToolFactoryOptions {
  serverName: string;
  tool: McpTool;
  call(rawName: string, args: Record<string, unknown>, exec: ToolExecution): Promise<CallToolResult>;
  services: ToolServices;
}

interface ToolValue {
  content: unknown[];
  structuredContent?: unknown;
}

/** Build one ToolDefinition for an MCP tool. */
export function makeToolDefinition(options: ToolFactoryOptions): ToolDefinition {
  const { serverName, tool, call, services } = options;
  const rawName = tool.name;
  const projections = new WeakMap<ToolExecution, { value: ToolValue; fallback: ContentBlock[]; content: ContentBlock[] }>();
  const description = (tool.description?.trim()
    || `${tool.title ?? tool.annotations?.title ?? rawName} (from MCP server "${serverName}")`).slice(0, 4000);
  const definition: ToolDefinition = {
    name: publicToolName(serverName, rawName),
    description,
    parameters: sanitizeInputSchema(tool.inputSchema),
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        return [{ type: 'text', text: extractText(isRecord(value) ? value['content'] : [], rawName) }];
      },
    },
    async execute(args, exec) {
      const result = await call(rawName, isRecord(args) ? args : {}, exec);
      const content = Array.isArray(result?.content) ? result.content : [];
      if (result?.isError === true) throw new Error(extractText(content, rawName) || `MCP tool "${rawName}" reported an error`);
      const value: ToolValue = { content };
      if (result?.structuredContent !== undefined && result.structuredContent !== null) value.structuredContent = result.structuredContent;
      if (content.some((b) => isRecord(b) && b['type'] === 'image')) {
        const fallback: ContentBlock[] = [{ type: 'text', text: extractText(content, rawName) }];
        projections.set(exec, { value, fallback, content: await prepareImageProjection(services, exec, content, rawName) });
      }
      return value;
    },
    projectContent(exec, result) {
      const projection = projections.get(exec);
      if (projection === undefined) return undefined;
      projections.delete(exec);
      if (result.isError) return undefined;
      if (!isDeepStrictEqual(result.value, projection.value)) return undefined;
      if (!isDeepStrictEqual(result.content, projection.fallback)) return undefined;
      return projection.content;
    },
  };
  if (tool.annotations?.readOnlyHint === true) definition.isConcurrencySafe = () => true;
  return definition;
}

export interface Registration {
  name: string;
  signature: string;
  dispose: Disposer;
}

function signatureOf(definition: ToolDefinition): string {
  return JSON.stringify([definition.name, definition.description, definition.parameters, Boolean(definition.isConcurrencySafe)]);
}

/**
 * Reconcile one server's registrations in one registry: keep unchanged tools,
 * replace changed ones, drop vanished ones.
 */
export function syncRegistrations(
  register: (definition: ToolDefinition) => Disposer,
  registrations: Map<string, Registration>,
  definitions: ReadonlyMap<string, ToolDefinition>,
): { added: number; removed: number; errors: string[] } {
  const errors: string[] = [];
  let added = 0;
  let removed = 0;
  for (const [raw, entry] of [...registrations]) {
    const next = definitions.get(raw);
    if (next && signatureOf(next) === entry.signature) continue;
    try { void entry.dispose(); } catch {}
    registrations.delete(raw);
    removed += 1;
  }
  for (const [raw, definition] of definitions) {
    if (registrations.has(raw)) continue;
    try {
      const dispose = register(definition);
      registrations.set(raw, { name: definition.name, signature: signatureOf(definition), dispose: typeof dispose === 'function' ? dispose : () => {} });
      added += 1;
    } catch (error) {
      errors.push(`${definition.name}: ${(error as Error)?.message ?? error}`);
    }
  }
  return { added, removed, errors };
}

export function disposeRegistrations(registrations: Map<string, Registration>): void {
  for (const entry of registrations.values()) { try { void entry.dispose(); } catch {} }
  registrations.clear();
}
