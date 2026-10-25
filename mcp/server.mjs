#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULTS, PROTOCOL_VERSION, VERSION } from '../lib/defaults.mjs';
import { loadRuleSet } from '../lib/io.mjs';
import { parseDialogue } from '../lib/dialogue.mjs';
import { scanDialogue } from '../lib/scan.mjs';
import { collectNames, presentScan } from '../lib/present.mjs';
import { applyAttributions } from '../lib/attribution.mjs';
import { buildReport, formatReport } from '../lib/report.mjs';
import { summarizeRedundancy } from '../lib/rewrite.mjs';
import { rewriterFromEnv } from '../lib/rewriter.mjs';
import { selfCheckText } from '../lib/selfcheck.mjs';

export const SERVER_NAME = 'koupi';

export const TOOLS = [
  {
    name: 'tic_scan',
    description: '扫描一段角色扮演文本里的模型口癖，返回命中、类别、不可判定项，以及句式口癖的冗余比。不读取仓库外的文件，不调用模型。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '纯文本，或对话 JSON / Markdown' },
        redact: { type: 'boolean', description: '只保留命中两侧窗口，并替换人名' },
        names: { type: 'array', items: { type: 'string' }, description: '要替换的人名' },
        window: { type: 'number', description: '脱敏窗口字数，默认 24' },
        roles: { type: 'array', items: { type: 'string' }, description: '参与统计的角色，默认 assistant' },
      },
      required: ['text'],
    },
  },
  {
    name: 'tic_report',
    description: '统计口癖密度和冗余比。句式模板单独给出每千字、每轮和阈值告警。冗余比给出均值、最大值和每千字冗余字。不可判定不计入密度，也不计入冗余比。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '纯文本，或对话 JSON / Markdown' },
        templateThreshold: { type: 'number', description: '句式模板全篇每千字告警线，默认 4' },
        turnThreshold: { type: 'number', description: '单轮每千字告警线，默认 10' },
        minTurnChars: { type: 'number', description: '单轮密度告警的最小字数，默认 30' },
        roles: { type: 'array', items: { type: 'string' } },
      },
      required: ['text'],
    },
  },
  {
    name: 'tic_rewrite',
    description: '回复前自查。先扫描草稿，若有口癖，把命中片段、类别和省力改写交给改写器，最多重写 2 轮后再扫。默认 offline，不调用模型；删完句子不成立时保留原句，disposition 为 needs-model，并带回命中。llm 模式只从环境变量 KOUPI_LLM_API_KEY 读密钥。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '待发送的回复草稿' },
        before: { type: 'string', description: '这条回复之前的对话，用来判断绕路否定。不传则只看草稿自身' },
        rewriter: { type: 'string', description: 'offline 或 llm，默认 offline' },
        maxRounds: { type: 'number', description: '最多重写轮数，默认 2，上限 2' },
      },
      required: ['text'],
    },
  },
];

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function fail(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    isError: false,
  };
}

function dialogueFrom(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new RpcError(-32602, 'text 必须是非空字符串');
  }
  try {
    return parseDialogue(text, 'mcp');
  } catch (error) {
    throw new RpcError(-32602, error.message);
  }
}

function scanPrepared(ruleSet, text, args) {
  const dialogue = dialogueFrom(text);
  const roles = Array.isArray(args.roles) && args.roles.length ? args.roles : [...DEFAULTS.roles];
  const redact = Boolean(args.redact);
  const names = redact ? collectNames(dialogue, args.names || []) : (args.names || []);
  const options = {
    roles,
    proximity: DEFAULTS.proximity,
    redact,
    window: Number.isFinite(args.window) ? args.window : DEFAULTS.window,
    names,
    templateThreshold: Number.isFinite(args.templateThreshold) ? args.templateThreshold : DEFAULTS.templateThreshold,
    turnThreshold: Number.isFinite(args.turnThreshold) ? args.turnThreshold : DEFAULTS.turnThreshold,
    minTurnChars: Number.isFinite(args.minTurnChars) ? args.minTurnChars : DEFAULTS.minTurnChars,
  };
  const scan = scanDialogue(dialogue, ruleSet, options);
  const hits = applyAttributions(scan.hits, { items: [] });
  const byId = new Map(hits.map((hit) => [hit.id, hit]));
  const attributed = {
    ...scan,
    hits,
    turns: scan.turns.map((turn) => ({
      ...turn,
      hits: turn.hits.map((hit) => byId.get(hit.id) || hit),
    })),
  };
  return { dialogue, options, scan: attributed };
}

function callTool(ruleSet, params) {
  const name = params?.name;
  const args = params?.arguments || {};
  if (name === 'tic_scan') {
    const { options, scan } = scanPrepared(ruleSet, args.text, args);
    const presented = presentScan(scan, options);
    const templateHits = presented.hits.filter((hit) => hit.category === 'template' && hit.verdict === 'tic');
    return toolResult({
      chars: presented.chars,
      hits: presented.hits,
      suppressed: presented.suppressed,
      templateTicCount: templateHits.length,
      redundancy: summarizeRedundancy(templateHits, presented.chars),
    });
  }
  if (name === 'tic_rewrite') {
    if (typeof args.text !== 'string' || !args.text.trim()) {
      throw new RpcError(-32602, 'text 必须是非空字符串');
    }
    const mode = args.rewriter || 'offline';
    const rewriter = rewriterFromEnv(mode);
    const checked = selfCheckText(args.text, ruleSet, {
      rewriter,
      maxRounds: Number.isFinite(args.maxRounds) ? args.maxRounds : 2,
      before: Object.prototype.hasOwnProperty.call(args, 'before') ? args.before : undefined,
    });
    const view = (result) => toolResult({
      rewriter: mode,
      original: result.original,
      text: result.text,
      changed: result.changed,
      rewriteRounds: result.rewriteRounds,
      disposition: result.disposition,
      needsModel: result.needsModel,
      feedback: result.feedback,
      fidelity: result.fidelity,
      completeness: result.completeness,
      charDelta: result.charDelta,
      before: result.before,
      after: result.after,
      rounds: result.rounds.map((round) => ({
        round: round.round,
        ticCount: round.ticCount,
        hits: round.hits.map((hit) => ({
          text: hit.text,
          category: hit.category,
          ruleId: hit.ruleId,
          rewrite: hit.rewrite,
        })),
      })),
    });
    if (checked && typeof checked.then === 'function') return checked.then(view);
    return view(checked);
  }
  if (name === 'tic_report') {
    const { dialogue, options, scan } = scanPrepared(ruleSet, args.text, args);
    const report = buildReport(scan, dialogue, ruleSet, options);
    return toolResult({
      text: formatReport(report),
      chars: report.chars,
      perKilo: report.perKilo,
      template: report.template,
      categories: report.categories,
      curve: report.curve,
      persona: report.persona,
      redundancy: report.redundancy,
    });
  }
  throw new RpcError(-32602, `未知工具 ${name || ''}`);
}

export function createHandler(ruleSet) {
  return function handle(message) {
    if (!message || typeof message !== 'object') return fail(null, -32600, '无效请求');
    const { id, method, params } = message;
    if (!method) return fail(id, -32600, '无效请求');
    if (method.startsWith('notifications/')) return null;
    if (id === undefined || id === null) return null;
    try {
      if (method === 'initialize') {
        return ok(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: VERSION },
        });
      }
      if (method === 'ping') return ok(id, {});
      if (method === 'tools/list') return ok(id, { tools: TOOLS });
      if (method === 'tools/call') {
        const out = callTool(ruleSet, params || {});
        if (out && typeof out.then === 'function') return out.then((value) => ok(id, value));
        return ok(id, out);
      }
      return fail(id, -32601, `未知方法 ${method}`);
    } catch (error) {
      return fail(id, error.code || -32603, error.message);
    }
  };
}

export function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8');
  return Buffer.concat([header, body]);
}

export function createFrameParser(onMessage, onError) {
  let buf = Buffer.alloc(0);
  return function push(chunk) {
    buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (buf.length) {
      const sep = buf.indexOf('\r\n\r\n');
      if (sep === -1) return;
      const header = buf.slice(0, sep).toString('utf8');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        onError(new Error('缺少 Content-Length'));
        buf = buf.slice(sep + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = sep + 4;
      if (buf.length < start + length) return;
      const body = buf.slice(start, start + length).toString('utf8');
      buf = buf.slice(start + length);
      try {
        onMessage(JSON.parse(body));
      } catch (error) {
        onError(error);
      }
    }
  };
}

export function runServer({ stdin, stdout, stderr = null, ruleSet }) {
  const handle = createHandler(ruleSet);
  const write = (message) => {
    if (message) stdout.write(encodeFrame(message));
  };
  const push = createFrameParser(
    (message) => {
      const result = handle(message);
      if (result && typeof result.then === 'function') {
        result.then(write, (error) => write(fail(message?.id ?? null, error.code || -32603, error.message)));
        return;
      }
      write(result);
    },
    () => write(fail(null, -32700, 'JSON 解析失败')),
  );
  stdin.on('data', push);
  return new Promise((resolve) => {
    stdin.on('end', resolve);
    stdin.on('error', (error) => {
      stderr?.write(`${error.message}\n`);
      resolve();
    });
  });
}

function defaultRules() {
  return loadRuleSet(join(dirname(fileURLToPath(import.meta.url)), '..', 'tics', 'default.json'));
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  runServer({
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    ruleSet: defaultRules(),
  });
}
