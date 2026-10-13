import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/qwen-realtime' });
const logDir = path.resolve('session-logs');
fs.mkdirSync(logDir, { recursive: true });
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
function promptFor(slide) { return `你是中文 PPT 讲师。当前正在展示第 ${slide.id} 页《${slide.name}》，页面内容：${slide.content}。只回答用户当前问题，先给结论再给必要解释；不要展示或朗读思考过程，不要主动提及其他页面。只有用户明确说上一页、下一页或跳转到第 N 页时才执行翻页意图。`; }

wss.on('connection', (browser) => {
  const taskId = crypto.randomUUID();
  let currentSlide = 0;
  let activeResponse = false;
  const session = { session_id: taskId, started_at: new Date().toISOString(), ended_at: null, audio_in_bytes: 0, audio_in_frames: 0, timeline: [] };
  const logFile = path.join(logDir, `${session.started_at.replace(/[:.]/g, '-')}-${taskId}.json`);
  const record = (direction, type, data = {}) => { session.timeline.push({ at: new Date().toISOString(), direction, type, ...data }); fs.writeFileSync(logFile, JSON.stringify(session, null, 2)); };
  record('system', 'session.started', { model: process.env.QWEN_MODEL, workspace_id: process.env.DASHSCOPE_WORKSPACE_ID, app_id: process.env.DASHSCOPE_APP_ID });
  const host = process.env.DASHSCOPE_API_HOST || 'dashscope.aliyuncs.com';
  const model = process.env.QWEN_MODEL || 'qwen-audio-3.0-realtime-flash';
  const qwen = new WebSocket(`wss://${host}/api-ws/v1/realtime?model=${encodeURIComponent(model)}`, {
    headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY || ''}` }
  });
  qwen.on('open', () => { const message = { type: 'session.update', session: { modalities: ['text', 'audio'], voice: 'longanqian', input_audio_format: 'pcm16', output_audio_format: 'pcm16', input_audio_transcription: { model: 'fun-asr' }, turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 800 }, instructions: promptFor(slides[currentSlide]) } }; record('client', 'session.update', { data: message.session }); qwen.send(JSON.stringify(message)); });
  qwen.on('message', (data, isBinary) => {
    if (isBinary) return browser.send(data);
    const text = data.toString();
    try {
      const msg = JSON.parse(text);
      if (msg.type === 'response.created') activeResponse = true;
      if (msg.type === 'response.done') activeResponse = false;
      const safe = { ...msg }; if (safe.delta && typeof safe.delta === 'string' && safe.delta.length > 200) safe.delta = `[audio delta ${safe.delta.length} chars]`;
      record('qwen', msg.type || 'message', { data: safe });
      send(browser, { type: 'qwen-event', event: msg.type, raw: msg });
    } catch { record('qwen', 'text', { data: text }); send(browser, { type: 'qwen-text', text }); }
  });
  qwen.on('close', () => browser.close());
  qwen.on('error', (error) => { record('qwen', 'error', { message: error.message }); send(browser, { type: 'error', message: error.message }); });
  browser.on('message', (data, isBinary) => {
    if (isBinary) { session.audio_in_bytes += data.length; session.audio_in_frames += 1; if (session.audio_in_frames % 20 === 0) record('client', 'audio.frames', { frames: session.audio_in_frames, bytes: session.audio_in_bytes }); if (qwen.readyState === WebSocket.OPEN) qwen.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: data.toString('base64') })); return; }
    try { const message = JSON.parse(data.toString()); record('client', message.type || 'message', { data: message }); if (message.type === 'ui-action') { if (message.slide_index !== undefined) { currentSlide = Math.max(0, Math.min(slides.length - 1, Number(message.slide_index))); const update = { type: 'session.update', session: { instructions: promptFor(slides[currentSlide]) } }; record('client', 'context.update', { data: { slide_index: currentSlide, slide_id: slides[currentSlide].id } }); if (qwen.readyState === WebSocket.OPEN) qwen.send(JSON.stringify(update)); } } else if (message.type === 'response.cancel') { if (activeResponse && qwen.readyState === WebSocket.OPEN) qwen.send(JSON.stringify(message)); } else if (qwen.readyState === WebSocket.OPEN) qwen.send(JSON.stringify(message)); } catch { record('client', 'invalid_message', { data: data.toString() }); }
  });
  browser.on('close', () => { session.ended_at = new Date().toISOString(); record('system', 'session.ended', { audio_in_bytes: session.audio_in_bytes, audio_in_frames: session.audio_in_frames }); if (qwen.readyState === WebSocket.OPEN) qwen.close(); });
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.log(`PPT voice MVP: http://localhost:${port}`));
