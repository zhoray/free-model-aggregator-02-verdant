import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';

type Json = Record<string, unknown>;
type ModelRow = {
  id: string;
  display_name?: string;
  rating_milli: number;
  context_length: number | null;
  tools: boolean;
  vision: boolean;
  json: boolean;
  free: boolean;
};
type Requirement = {
  tools: boolean;
  vision: boolean;
  json: boolean;
};
type PromptRow = {
  id: string;
  requires: Requirement;
};
type Brief = {
  models: ModelRow[];
  prompts: PromptRow[];
};
type Catalog = {
  providers: Array<{
    id: string;
    base_url: string;
    key_env: string;
    wire: string;
    models: Array<{
      id: string;
      free: boolean;
      context_length: number | null;
    }>;
  }>;
};
type Failure = {
  status: number;
  code: string;
  model: string;
};

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function log(msg: string) {
  process.stderr.write(`aggregator: ${msg}\n`);
}

function sendJson(res: ServerResponse, status: number, body: Json, extraHeaders: Record<string, string> = {}) {
  const json = JSON.stringify(body);
  res.setHeader('content-type', 'application/json');
  res.setHeader('content-length', Buffer.byteLength(json, 'utf8').toString());
  Object.entries(extraHeaders).forEach(([k, v]) => res.setHeader(k, v));
  res.writeHead(status);
  res.end(json);
}

function openAIError(message: string, type: string) {
  return { error: { message, type, code: null } };
}

function anthropicError(type: string, message: string) {
  return { type: 'error', error: { type, message } };
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string) {
  if (wire === 'anthropic') {
    sendJson(res, status, anthropicError(type, message));
  } else {
    sendJson(res, status, openAIError(message, type));
  }
}

function isFreeModel(model: ModelRow): boolean {
  return model.free === true;
}

function readBrief(path: string): Brief {
  try {
    const content = readFileSync(path, 'utf8');
    const lines = content.split('\n');
    let models: ModelRow[] = [];
    let prompts: PromptRow[] = [];
    for (let line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      if (trimmed.startsWith('{')) {
        try {
          const obj = JSON.parse(trimmed);
          if (isRecord(obj) && 'schema' in obj && obj.schema === 'free-model-aggregator-02/models/v1') {
            const data = (obj.models ?? []) as unknown[];
            for (let item of data) {
              if (isRecord(item) && typeof item.id === 'string') {
                const m: ModelRow = {
                  id: item.id,
                  display_name: typeof item.display_name === 'string' ? item.display_name : undefined,
                  rating_milli: typeof item.rating_milli === 'number' ? item.rating_milli : Number(item.rating_milli) || 0,
                  context_length: item.context_length === null ? null : Number(item.context_length) || 0,
                  tools: item.tools === true,
                  vision: item.vision === true,
                  json: item.json === true,
                  free: item.free === true
                };
                models.push(m);
              }
            }
          } else if (isRecord(obj) && 'schema' in obj && obj.schema === 'free-model-aggregator-02/prompts/v1') {
            const data = (obj.prompts ?? []) as unknown[];
            for (let item of data) {
              if (isRecord(item) && typeof item.id === 'string') {
                const req = {
                  tools: item.requires && isRecord(item.requires) && item.requires.tools === true,
                  vision: item.requires && isRecord(item.requires) && item.requires.vision === true,
                  json: item.requires && isRecord(item.requires) && item.requires.json === true
                };
                prompts.push({ id: item.id, requires: req });
              }
            }
          }
        } catch (e) {
          log(`JSON parse error on line: ${e}`);
        }
      }
    }
    return { models, prompts };
  } catch (e) {
    log(`read error: ${e}`);
    return { models: [], prompts: [] };
  }
}

function buildCatalog(brief: Brief): Catalog {
  const freeModels = brief.models.filter(isFreeModel);
  if (freeModels.length === 0) {
    return { providers: [] };
  }
  return {
    providers: [{
      id: 'openrouter',
      base_url: 'https://openrouter.ai/api/v1',
      key_env: 'OPENROUTER_API_KEY',
      wire: 'openai',
      models: freeModels.map(m => ({
        id: m.id,
        free: m.free,
        context_length: m.context_length
      }))
    }]
  };
}

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';

const brief = readBrief(PROMPT_FILE);
const catalog = buildCatalog(brief);

if (process.argv.includes('--list')) {
  const json = JSON.stringify(catalog) + '\n';
  process.stdout.write(json, () => process.exit(0));
}

function openAIModelList(models: ModelRow[]) {
  return {
    object: 'list',
    data: models.map(m => ({
      id: m.id,
      object: 'model',
      created: 0,
      owned_by: 'openrouter'
    }))
  };
}

function anthropicModelList(models: ModelRow[]) {
  if (models.length === 0) {
    return { data: [], has_more: false, first_id: null, last_id: null };
  }
  const first = models[0];
  return {
    data: models.map(m => ({
      id: m.id,
      type: 'model',
      display_name: m.display_name ?? m.id,
      created_at: '2026-01-01T00:00:00Z'
    })),
    has_more: false,
    first_id: first.id,
    last_id: models[models.length - 1].id
  };
}

async function modelsHandler(req: IncomingMessage, res: ServerResponse) {
  const models = brief.models.filter(isFreeModel);
  if (req.headers['x-api-key'] && typeof req.headers['x-api-key'] === 'string') {
    sendJson(res, 200, anthropicModelList(models));
  } else {
    sendJson(res, 200, openAIModelList(models));
  }
}

type ClientWire = 'openai' | 'anthropic';
type GatewayOutcome =
  | { ok: true; modelId: string; bodyText: string; failures: Failure[] }
  | { ok: false; status: number; code: string; failures: Failure[] };

let arrivalIndex = 0;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function readRequestBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let body = '';
    let size = 0;
    const MAX = 8 * 1024 * 1024;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX) {
        req.destroy();
        resolve(null);
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => {
      resolve(body || null);
    });
    req.on('error', () => resolve(null));
  });
}

function requirementsFor(wire: ClientWire, body: Json): Requirement {
  const row = brief.prompts[arrivalIndex];
  arrivalIndex += 1;
  if (row) return row.requires;
  let tools = false;
  let json = false;
  let vision = false;
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (const m of msgs) {
    if (isRecord(m) && Array.isArray(m.content)) {
      for (const p of m.content) {
        if (isRecord(p) && (p.type === 'image' || p.type === 'image_url' || p.type === 'input_image')) {
          vision = true;
          break;
        }
      }
    }
    if (isRecord(m) && Array.isArray(m.tool_calls)) tools = true;
    if (isRecord(m) && isRecord(m.tool_use_id)) tools = true;
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) tools = true;
  if (isRecord(body.response_format)) json = true;
  return { tools, json, vision };
}

function candidatesFor(req: Requirement): ModelRow[] {
  const all = brief.models.filter(m => m.free === true && (!req.tools || m.tools) && (!req.vision || m.vision) && (!req.json || m.json));
  return [...all].sort((a, b) => b.rating_milli - a.rating_milli);
}

function maxTokensFor(wire: ClientWire, body: Json): number {
  let raw: number | undefined;
  if (wire === 'openai') {
    raw = body.max_tokens ?? body.max_completion_tokens;
  } else {
    raw = body.max_tokens;
  }
  let n = 1024;
  if (typeof raw === 'number' && Number.isFinite(raw)) n = Math.floor(raw);
  return Math.max(1, Math.min(n, 8192));
}

function anthropicMessagesToOpenAI(body: Json): unknown[] {
  const out: unknown[] = [];
  // system
  if (typeof body.system === 'string' && body.system !== '') {
    out.push({ role: 'system' as const, content: body.system });
  } else if (Array.isArray(body.system)) {
    let joined = '';
    for (const block of body.system) {
      if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
        joined += block.text;
      }
    }
    if (joined !== '') {
      out.push({ role: 'system' as const, content: joined });
    }
  }
  // messages
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRecord(message) || typeof message.role !== 'string') continue;
    if (typeof message.content === 'string') {
      out.push({ role: message.role, content: message.content });
      continue;
    }
    if (Array.isArray(message.content)) {
      const toolMessages: unknown[] = [];
      const parts: unknown[] = [];
      const toolCalls: unknown[] = [];
      for (const block of message.content) {
        if (!isRecord(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push({ type: 'text' as const, text: block.text });
        } else if (block.type === 'image' && isRecord(block.source)) {
          let url = '';
          if (block.source.type === 'base64') {
            url = `data:${block.source.media_type};base64,${block.source.data}`;
          } else if (typeof block.source.url === 'string') {
            url = block.source.url;
          }
          if (url !== '') parts.push({ type: 'image_url' as const, image_url: { url } });
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: typeof block.id === 'string' ? block.id : 'toolu_0',
            type: 'function' as const,
            function: {
              name: typeof block.name === 'string' ? block.name : '',
              arguments: JSON.stringify(isRecord(block.input) || Array.isArray(block.input) ? block.input : {})
            }
          });
        } else if (block.type === 'tool_result') {
          toolMessages.push({
            role: 'tool' as const,
            tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
            content: typeof block.content === 'string' ? block.content : (Array.isArray(block.content) ? block.content.map((c: any) => typeof c.text === 'string' ? c.text : '').join('') : '')
          });
        }
      }
      // push toolMessages first
      out.push(...toolMessages);
      // now the combined message
      if (parts.length > 0 || toolCalls.length > 0) {
        const msg: any = { role: message.role };
        if (parts.length === 1 && parts[0].type === 'text' && toolCalls.length === 0) {
          msg.content = parts[0].text;
        } else if (parts.length > 0) {
          msg.content = parts;
        } else {
          msg.content = null;
        }
        if (toolCalls.length > 0) {
          msg.tool_calls = toolCalls;
        }
        out.push(msg);
      }
    }
  }
  return out;
}

function anthropicToolsToOpenAI(body: Json): unknown[] | undefined {
  if (!Array.isArray(body.tools)) return undefined;
  return body.tools.map((t: any) => {
    if (!isRecord(t)) return { type: 'function' as const, function: { name: '', description: '', parameters: { type: 'object' as const } } };
    return {
      type: 'function' as const,
      function: {
        name: typeof t.name === 'string' ? t.name : '',
        description: typeof t.description === 'string' ? t.description : '',
        parameters: isRecord(t.input_schema) ? t.input_schema : { type: 'object' as const }
      }
    };
  });
}

function anthropicToolChoiceToOpenAI(body: Json): unknown {
  if (!isRecord(body.tool_choice)) return undefined;
  const t = body.tool_choice;
  if (t.type === 'auto') return 'auto';
  if (t.type === 'any') return 'required';
  if (t.type === 'none') return 'none';
  if (t.type === 'tool') {
    const name = typeof t.name === 'string' ? t.name : '';
    if (name) return { type: 'function' as const, function: { name } };
  }
  return undefined;
}

function buildGatewayBody(wire: ClientWire, body: Json, modelId: string): Json {
  const gw: any = { model: modelId, max_tokens: maxTokensFor(wire, body) };
  if (wire === 'openai') {
    if (Array.isArray(body.messages)) gw.messages = body.messages;
    if (body.response_format !== undefined) gw.response_format = body.response_format;
    if (Array.isArray(body.tools)) gw.tools = body.tools;
    if (body.tool_choice !== undefined) gw.tool_choice = body.tool_choice;
    if (body.stop !== undefined) gw.stop = body.stop;
  } else {
    gw.messages = anthropicMessagesToOpenAI(body);
    const tools = anthropicToolsToOpenAI(body);
    if (tools !== undefined) gw.tools = tools;
    const tc = anthropicToolChoiceToOpenAI(body);
    if (tc !== undefined) gw.tool_choice = tc;
    if (Array.isArray(body.stop_sequences)) gw.stop = body.stop_sequences;
  }
  if (typeof body.temperature === 'number') gw.temperature = body.temperature;
  if (typeof body.top_p === 'number') gw.top_p = body.top_p;
  if (body.stream === true) {
    gw.stream = true;
    gw.stream_options = { include_usage: true };
  }
  return gw;
}

function errorCodeOf(text: string): string {
  try {
    const parsed = JSON.parse(text);
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const err = parsed.error;
      if (typeof err.code === 'string' && err.code !== '') return err.code.slice(0, 64);
      if (typeof err.type === 'string' && err.type !== '') return err.type.slice(0, 64);
    }
    return '';
  } catch {
    return '';
  }
}

async function dialOnce(gwBody: Json): Promise<{status: number, text: string} | null> {
  try {
    const url = chatCompletionsUrl();
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${GATEWAY_KEY}` },
      body: JSON.stringify(gwBody),
      signal: AbortSignal.timeout(20000)
    });
    const text = await resp.text();
    return { status: resp.status, text };
  } catch {
    return null;
  }
}

async function runAttempts(wire: ClientWire, body: Json, candidates: ModelRow[]): Promise<GatewayOutcome> {
  const failures: Failure[] = [];
  for (const cand of candidates.slice(0, 4)) {
    const gwBody = buildGatewayBody(wire, body, cand.id);
    let attempt = 0;
    while (attempt < 2) {
      attempt += 1;
      const r = await dialOnce(gwBody);
      if (r !== null && r.status >= 200 && r.status < 300) {
        return { ok: true, modelId: cand.id, bodyText: r.text, failures };
      }
      if (r !== null) {
        const code = errorCodeOf(r.text);
        failures.push({ status: r.status, code, model: cand.id });
        if ((r.status === 429 || r.status >= 500) && attempt < 2) {
          await sleep(1200);
          continue;
        }
        break;
      }
      // network error: retry once
      if (attempt < 2) {
        await sleep(1200);
        continue;
      }
      break;
    }
  }
  const last = failures.length > 0 ? failures[failures.length - 1] : null;
  return { ok: false, status: last ? last.status : 502, code: last ? last.code : '', failures };
}

function mapFinishReason(fr: any): string {
  if (fr === 'stop') return 'end_turn';
  if (fr === 'length') return 'max_tokens';
  if (fr === 'tool_calls') return 'tool_use';
  if (fr === 'function_call') return 'tool_use';
  if (fr === 'content_filter') return 'refusal';
  return 'end_turn';
}

function openAIToAnthropicMessage(answer: Json, modelId: string): Json {
  const choice = Array.isArray(answer.choices) ? answer.choices[0] : undefined;
  const message = isRecord(choice) && isRecord(choice.message) ? choice.message : {};
  const blocks: any[] = [];
  if (typeof message.content === 'string' && message.content !== '') {
    blocks.push({ type: 'text', text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (isRecord(part) && part.type === 'text' && typeof part.text === 'string' && part.text !== '') {
        blocks.push({ type: 'text', text: part.text });
      }
    }
  }
  if (Array.isArray(message.tool_calls)) {
    for (let i = 0; i < message.tool_calls.length; i++) {
      const call = message.tool_calls[i];
      if (!isRecord(call)) continue;
      const fn = isRecord(call.function) ? call.function : {};
      let args: any = {};
      if (typeof fn.arguments === 'string') {
        try {
          args = JSON.parse(fn.arguments);
        } catch {}
      }
      blocks.push({
        type: 'tool_use',
        id: isRecord(call) && typeof call.id === 'string' ? call.id : `toolu_${i}`,
        name: typeof fn.name === 'string' ? fn.name : '',
        input: (isRecord(args) || Array.isArray(args)) ? args : {}
      });
    }
  }
  if (blocks.length === 0) {
    blocks.push({ type: 'text', text: '' });
  }
  const usage = isRecord(answer.usage) ? answer.usage : {};
  return {
    id: typeof answer.id === 'string' ? answer.id : 'msg_aggregator',
    type: 'message',
    role: 'assistant',
    model: modelId,
    content: blocks,
    stop_reason: mapFinishReason(isRecord(choice) ? choice.finish_reason : undefined),
    stop_sequence: null,
    usage: {
      input_tokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
      output_tokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0
    }
  };
}

type StreamToolCall = { id: string; name: string; arguments: string };

function parseSseChunks(text: string): Json[] {
  const out: Json[] = [];
  for (const frame of text.split(/\r?\n\r?\n|\n\n/)) {
    const dataLines: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length === 0) continue;
    const payload = dataLines.join('\n').trim();
    if (payload === '' || payload === '[DONE]') continue;
    try {
      const v = JSON.parse(payload);
      if (isRecord(v)) out.push(v);
    } catch {}
  }
  return out;
}

function usageOf(u: any): { prompt_tokens: number; completion_tokens: number } | null {
  if (!isRecord(u) || typeof u.prompt_tokens !== 'number' || typeof u.completion_tokens !== 'number') {
    return null;
  }
  return { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens };
}

function normalizeGatewayAnswer(bodyText: string): NormalizedAnswer {
  const trimmed = bodyText.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (isRecord(parsed)) {
        const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
        const message = isRecord(choice) && isRecord(choice.message) ? choice.message : {};
        let text = '';
        if (typeof message.content === 'string') {
          text = message.content;
        } else if (Array.isArray(message.content)) {
          text = message.content.filter((part: any) => isRecord(part) && part.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('');
        }
        const toolCalls: StreamToolCall[] = [];
        if (isRecord(message) && Array.isArray(message.tool_calls)) {
          for (const tc of message.tool_calls) {
            if (isRecord(tc)) {
              toolCalls.push({
                id: typeof tc.id === 'string' ? tc.id : '',
                name: typeof tc.function?.name === 'string' ? tc.function.name : '',
                arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : ''
              });
            }
          }
        }
        const finishReason = isRecord(choice) && typeof choice.finish_reason === 'string' ? choice.finish_reason : null;
        const usage = usageOf(parsed.usage);
        return { id: typeof parsed.id === 'string' ? parsed.id : 'msg_aggregator', created: typeof parsed.created === 'number' ? parsed.created : 0, text, toolCalls, finishReason, usage, chunks: null };
      }
    } catch {}
  }
  const chunks = parseSseChunks(bodyText);
  let id = 'msg_aggregator';
  let created = 0;
  let usage = null;
  let finishReason: string | null = null;
  let text = '';
  const toolCallAccum: { [key: number]: StreamToolCall } = {};
  for (const chunk of chunks) {
    if (isRecord(chunk)) {
      if (typeof chunk.id === 'string' && chunk.id !== '') id = chunk.id;
      if (typeof chunk.created === 'number') created = chunk.created;
      const chunkUsage = usageOf(chunk.usage);
      if (chunkUsage) usage = chunkUsage;
      const choice = isRecord(chunk) ? chunk.choices?.[0] : undefined;
      if (isRecord(choice) && typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
      const delta = isRecord(choice) ? choice.delta : undefined;
      if (isRecord(delta) && typeof delta.content === 'string') text += delta.content;
      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === 'number' ? tc.index : 0;
          if (typeof tc.id === 'string' && tc.id !== '') toolCallAccum[idx] = { ...toolCallAccum[idx], id: tc.id };
          const fn = isRecord(tc) ? tc.function : undefined;
          if (typeof fn?.name === 'string' && fn.name !== '') toolCallAccum[idx] = { ...toolCallAccum[idx], name: fn.name };
          if (typeof fn?.arguments === 'string') toolCallAccum[idx] = { ...toolCallAccum[idx], arguments: (toolCallAccum[idx]?.arguments || '') + fn.arguments };
        }
      }
    }
  }
  const toolCalls = Object.keys(toolCallAccum).sort((a, b) => parseInt(a) - parseInt(b)).map(k => toolCallAccum[parseInt(k)]);
  return { id, created, text, toolCalls, finishReason, usage, chunks };
}

function sendSse(res: any, frames: string[], headers: any) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
    ...headers
  });
  for (const frame of frames) {
    res.write(frame);
  }
  res.end();
}

function renderOpenAIStream(res: any, norm: NormalizedAnswer, modelId: string, headers: any) {
  const frames: string[] = [];
  if (norm.chunks !== null && norm.chunks.length > 0) {
    for (const chunk of norm.chunks) {
      frames.push('data: ' + JSON.stringify({ ...chunk, model: modelId }) + '\n\n');
    }
  } else {
    const base = { id: norm.id, object: 'chat.completion.chunk', created: norm.created, model: modelId };
    const delta: any = { role: 'assistant' };
    if (norm.text !== '') delta.content = norm.text;
    if (norm.toolCalls.length > 0) {
      delta.tool_calls = norm.toolCalls.map((tc, i) => ({
        index: i,
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments }
      }));
    }
    frames.push('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
    const finishChunk = { ...base, choices: [{ index: 0, delta: {}, finish_reason: norm.finishReason ?? 'stop' }] };
    if (norm.usage !== null) {
      finishChunk.usage = { prompt_tokens: norm.usage.prompt_tokens, completion_tokens: norm.usage.completion_tokens, total_tokens: norm.usage.prompt_tokens + norm.usage.completion_tokens };
    }
    frames.push('data: ' + JSON.stringify(finishChunk) + '\n\n');
  }
  frames.push('data: [DONE]\n\n');
  sendSse(res, frames, headers);
}

function renderAnthropicStream(res: any, norm: NormalizedAnswer, modelId: string, headers: any) {
  const frames: string[] = [];
  const ev = (name: string, obj: any) => {
    frames.push(`event: ${name}\n`);
    frames.push(`data: ${JSON.stringify(obj)}\n\n`);
  };
  ev('message_start', { type: 'message_start', message: { id: norm.id, type: 'message', role: 'assistant', model: modelId, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: norm.usage ? norm.usage.prompt_tokens : 0, output_tokens: 0 } } });
  let index = 0;
  if (norm.text !== '' || norm.toolCalls.length === 0) {
    ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    if (norm.text !== '') ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: norm.text } });
    ev('content_block_stop', { type: 'content_block_stop', index });
    index += 1;
  }
  for (const tc of norm.toolCalls) {
    ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: tc.id !== '' ? tc.id : 'toolu_' + index, name: tc.name, input: {} } });
    if (tc.arguments !== '') ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: tc.arguments } });
    ev('content_block_stop', { type: 'content_block_stop', index });
    index += 1;
  }
  ev('message_delta', { type: 'message_delta', delta: { stop_reason: mapFinishReason(norm.finishReason ?? undefined), stop_sequence: null }, usage: { output_tokens: norm.usage ? norm.usage.completion_tokens : 0 } });
  ev('message_stop', { type: 'message_stop' });
  sendSse(res, frames, headers);
}

async function serveCompletion(wire: ClientWire, req: IncomingMessage, res: ServerResponse) {
  const raw = await readRequestBody(req);
  if (raw === null) return sendError(res, wire, 400, 'invalid_request_error', 'the request body is not one JSON object');
  let body: Json;
  try {
    const v = JSON.parse(raw);
    if (!isRecord(v)) throw new Error('not an object');
    body = v;
  } catch {
    return sendError(res, wire, 400, 'invalid_request_error', 'the request body is not one JSON object');
  }
  const reqFor = requirementsFor(wire, body);
  const candidates = candidatesFor(reqFor);
  if (candidates.length === 0) return sendError(res, wire, 503, wire === 'anthropic' ? 'overloaded_error' : 'no_free_model', 'no free model in the brief meets this request');
  const outcome = await runAttempts(wire, body, candidates);
  const headers: Record<string, string> = outcome.failures.length > 0 ? { 'x-makefun-upstream-failures': JSON.stringify(outcome.failures.slice(0, 8)) } : {};
  if (!outcome.ok) {
    if (wire === 'anthropic') {
      return sendJson(res, outcome.status, { type: 'error', error: { type: 'api_error', message: `upstream refused: HTTP ${outcome.status}` } }, headers);
    }
    return sendJson(res, outcome.status, { error: { message: `upstream refused: HTTP ${outcome.status}`, type: 'upstream_error', code: outcome.code === '' ? null : outcome.code } }, headers);
  }
  if (body.stream === true) {
    const norm = normalizeGatewayAnswer(outcome.bodyText);
    if (wire === 'openai') return renderOpenAIStream(res, norm, outcome.modelId, headers);
    return renderAnthropicStream(res, norm, outcome.modelId, headers);
  }
  let answer: Json;
  try {
    const v = JSON.parse(outcome.bodyText);
    if (!isRecord(v)) throw new Error('not an object');
    answer = v;
  } catch {
    return sendError(res, wire, 502, 'upstream_error', 'the gateway answered a body that is not JSON');
  }
  if (wire === 'openai') {
    return sendJson(res, 200, { ...answer, model: outcome.modelId }, headers);
  }
  return sendJson(res, 200, openAIToAnthropicMessage(answer, outcome.modelId), headers);
}

function chatCompletionsUrl(): string {
  if (!GATEWAY_URL) return '';
  if (GATEWAY_URL.endsWith('/v1')) return GATEWAY_URL + '/chat/completions';
  return GATEWAY_URL + '/v1/chat/completions';
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  try {
    if (!req.url) {
      sendError(res, 'openai', 404, 'not_found', 'not found');
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;
    if (path === '/v1/models') {
      await modelsHandler(req, res);
      return;
    } else if (path === '/v1/chat/completions') {
      await serveCompletion('openai', req, res);
      return;
    } else if (path === '/v1/messages') {
      await serveCompletion('anthropic', req, res);
      return;
    } else {
      sendError(res, 'openai', 404, 'not_found', 'not found');
      return;
    }
  } catch (e) {
    log(`error: ${e}`);
    if (!res.headersSent) {
      sendError(res, 'openai', 500, 'internal_error', 'internal error');
    }
  }
}

async function startup() {
  try {
    if (process.argv.includes('--list')) return;
    if (!ENV_URL || !chatCompletionsUrl()) {
      throw new Error('missing required env');
    }
    const server = createServer(handle);
    const port = 8080;
    server.listen(0, '0.0.0.0', async () => {
      const actualPort = (server.address() as any).port;
      if (actualPort === 8080) {
        server.close();
        server.listen(0, '0.0.0.0', (err: any) => {
          if (err) throw err;
          register(actualPort);
        });
      } else {
        register(actualPort);
      }
    });
    function register(p: number) {
      const url = `${ENV_URL}/register`;
      let attempts = 0;
      const body = { protocol_version: 1, port: p, catalog };
      const interval = setInterval(async () => {
        attempts++;
        try {
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          });
          if (r.status === 200) {
            clearInterval(interval);
            pollWork();
            return;
          }
        } catch (e) {}
        if (attempts > 10) {
          clearInterval(interval);
          throw new Error('register failed');
        }
      }, 300);
    }
    function pollWork() {
      const interval = setInterval(async () => {
        try {
          const r = await fetch(`${ENV_URL}/work`, {
            signal: AbortSignal.timeout(2000)
          });
          const data = await r.json();
          if (data.done === true) {
            clearInterval(interval);
            server.close();
            process.exit(0);
          }
        } catch (e) {}
      }, 100);
    }
    process.on('SIGTERM', () => process.exit(0));
    process.on('SIGINT', () => process.exit(0));
  } catch (e) {
    log(`startup error: ${e}`);
    process.exit(1);
  }
}

startup();
