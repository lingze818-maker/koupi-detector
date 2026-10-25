import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeFrame, runServer } from '../mcp/server.mjs';
import { loadRuleSet } from '../lib/io.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseFrames(buffer) {
  const frames = [];
  let buf = buffer;
  while (buf.length) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep === -1) break;
    const header = buf.slice(0, sep).toString('utf8');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    const length = Number(match[1]);
    const start = sep + 4;
    const body = buf.slice(start, start + length);
    assert.equal(body.length, length);
    frames.push(JSON.parse(body.toString('utf8')));
    buf = buf.slice(start + length);
  }
  return frames;
}

test('帧长度按字节计，中文不会被截断', () => {
  const frame = encodeFrame({ text: '口癖' });
  const [message] = parseFrames(frame);
  assert.equal(message.text, '口癖');
});

test('stdio：initialize、tools/list、tic_scan、tic_report，坏帧不拖垮后续请求', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const chunks = [];
  stdout.on('data', (chunk) => chunks.push(chunk));
  const done = runServer({
    stdin,
    stdout,
    ruleSet: loadRuleSet(join(root, 'tics', 'default.json')),
  });

  const send = (message) => stdin.write(encodeFrame(message));
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  stdin.write(Buffer.from('Content-Length: 5\r\n\r\n{bad}'));
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'tic_scan',
      arguments: { text: '他没有生气，也没有惊讶，只是看着她。这不是红茶，而是乌龙。', redact: false },
    },
  });
  send({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'tic_rewrite',
      arguments: {
        text: '他没有生气，也没有惊讶，只是看着她。',
        rewriter: 'offline',
        maxRounds: 2,
      },
    },
  });
  send({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'tic_report',
      arguments: {
        text: JSON.stringify({
          title: '灯下',
          character: { name: '周衡', keywords: ['账本'], catchphrases: [] },
          turns: [
            { role: 'user', speaker: '林夏', text: '还开着吗？' },
            { role: 'assistant', speaker: '周衡', text: '他没有生气，也没有惊讶，只是把账本合上。' },
          ],
        }),
      },
    },
  });
  stdin.end();
  await done;

  const frames = parseFrames(Buffer.concat(chunks));
  const init = frames.find((frame) => frame.id === 1);
  assert.equal(init.result.protocolVersion, '2024-11-05');
  assert.equal(init.result.serverInfo.name, 'koupi');
  assert.equal(init.result.capabilities.tools.listChanged, false);

  const parseError = frames.find((frame) => frame.error?.code === -32700);
  assert.ok(parseError);

  const tools = frames.find((frame) => frame.id === 2).result.tools.map((tool) => tool.name);
  assert.deepEqual(tools, ['tic_scan', 'tic_report', 'tic_rewrite']);

  const scan = JSON.parse(frames.find((frame) => frame.id === 3).result.content[0].text);
  assert.ok(scan.hits.some((hit) => hit.ruleId === 'tpl.mei-you-ye-mei-you-zhi-shi' && hit.verdict === 'tic'));
  const detour = scan.hits.find((hit) => hit.subclass === 'detour-negation' && hit.text.includes('红茶'));
  assert.ok(detour);
  assert.equal(detour.redundancy.rewrite, '是乌龙');
  assert.ok(detour.redundancy.ratio > 1);
  assert.ok(scan.redundancy.mean > 1);
  assert.ok(scan.redundancy.redundantPerKilo > 0);

  const report = JSON.parse(frames.find((frame) => frame.id === 4).result.content[0].text);
  assert.ok(report.template.perKilo > 0);
  assert.equal(report.template.alert, true);
  assert.match(report.text, /句式模板/);
  assert.equal(report.persona.keywordHits, 1);
  assert.ok(report.redundancy.mean > 1);
  assert.ok(report.redundancy.redundantPerKilo > 0);
  assert.match(report.text, /冗余比/);

  const rewritten = JSON.parse(frames.find((frame) => frame.id === 5).result.content[0].text);
  assert.equal(rewritten.rewriter, 'offline');
  assert.equal(rewritten.text, '他只是看着她。');
  assert.equal(rewritten.after.ticCount, 0);
  assert.equal(rewritten.before.ticCount, 1);
  assert.ok(rewritten.fidelity > 0.99);
});
