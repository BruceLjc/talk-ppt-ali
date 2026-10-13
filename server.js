import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/qwen-realtime' });
const slides = [
  { id: 1, name: '第一页：实时语音交互', view_html: '<h1>实时语音交互</h1><p>浏览器中的自然语言控制与讲解</p>', content: '主题：实时语音交互；浏览器、语音、LLM、PPT 联动' },
  { id: 2, name: '第二页：系统架构', view_html: '<h1>系统架构</h1><div class="diagram">浏览器 ⇄ Node.js ⇄ Qwen Realtime</div>', content: '架构：浏览器采集音频；Node.js 保护 Key 并代理 WebSocket；Qwen 识别、推理、合成' },
  { id: 3, name: '第三页：核心流程', view_html: '<h1>核心流程</h1><ol><li>持续采集音频</li><li>VAD 检测说完</li><li>模型回答并执行动作</li></ol>', content: '流程：持续音频；服务端 VAD；意图识别；PPT 翻页；语音回答' },
  { id: 4, name: '第四页：支持的动作', view_html: '<h1>支持的动作</h1><p>上一页 · 下一页 · 跳转到第 N 页</p>', content: '动作：上一页、下一页、跳转到第 N 页' },
  { id: 5, name: '第五页：问答与讲解', view_html: '<h1>问答与讲解</h1><p>介绍当前页，或回答用户问题</p>', content: '模型可以介绍当前页，也可以基于 PPT 内容回答问题' }
];

app.use(express.static('public'));
app.get('/api/slides', (_req, res) => res.json(slides));

function send(ws, payload) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); }

wss.on('connection', (browser) => {
  const taskId = crypto.randomUUID();
  const host = process.env.DASHSCOPE_API_HOST || 'dashscope.aliyuncs.com';
  const model = process.env.QWEN_MODEL || 'qwen-audio-3.0-realtime-flash';
  const qwen = new WebSocket(`wss://${host}/api-ws/v1/realtime?model=${encodeURIComponent(model)}`, {
    headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY || ''}` }
  });
  let started = false;
  qwen.on('open', () => {
    qwen.send(JSON.stringify({ header: { action: 'run-task', task_id: taskId, streaming: 'duplex' }, payload: {
      task_group: 'aigc', task: 'multimodal-generation', function: 'generation', model: 'multimodal-dialog',
      input: { directive: 'Start', workspace_id: process.env.DASHSCOPE_WORKSPACE_ID, app_id: process.env.DASHSCOPE_APP_ID },
      parameters: { upstream: { type: 'AudioOnly', mode: 'duplex', audio_format: 'pcm', sample_rate: 16000, language: 'zh' }, downstream: { voice: 'longxiaochun_v2', sample_rate: 24000, audio_format: 'pcm', intermediate_text: 'transcript,dialog', incremental_response: true }, client_info: { user_id: 'ppt-mvp-user', device: { uuid: taskId } } }
    }}));
  });
  qwen.on('message', (data, isBinary) => {
    if (isBinary) return browser.send(data);
    const text = data.toString();
    try {
      const msg = JSON.parse(text);
      const event = msg?.payload?.output?.event || msg?.output?.event || msg?.event;
      if (event === 'Started') started = true;
      send(browser, { type: 'qwen-event', event, raw: msg });
    } catch { send(browser, { type: 'qwen-text', text }); }
  });
  qwen.on('close', () => browser.close());
  qwen.on('error', (error) => send(browser, { type: 'error', message: error.message }));
  browser.on('message', (data, isBinary) => {
    if (isBinary) { if (started && qwen.readyState === WebSocket.OPEN) qwen.send(data); return; }
    try { const message = JSON.parse(data.toString()); qwen.send(JSON.stringify(message)); } catch { }
  });
  browser.on('close', () => { if (qwen.readyState === WebSocket.OPEN) qwen.close(); });
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.log(`PPT voice MVP: http://localhost:${port}`));
