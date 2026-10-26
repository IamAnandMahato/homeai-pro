import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import mqtt from 'mqtt';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const prefix = (process.env.MQTT_TOPIC_PREFIX || 'homeai/demo-device').replace(/\/+$/, '');
const hasGemini = Boolean(process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEY.includes('PASTE_'));
const hasYoutube = Boolean(process.env.YOUTUBE_API_KEY && !process.env.YOUTUBE_API_KEY.includes('PASTE_'));

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '20kb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));

// Simple HTTP Basic Auth for a personal deployment. Always use HTTPS in production.
app.use((req, res, next) => {
  if (!process.env.APP_USERNAME || !process.env.APP_PASSWORD) {
    return res.status(503).send('Set APP_USERNAME and APP_PASSWORD in backend/.env before starting HomeAI.');
  }
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    let decoded = '';
    try { decoded = Buffer.from(encoded, 'base64').toString('utf8'); } catch {}
    const sep = decoded.indexOf(':');
    if (sep >= 0 && decoded.slice(0, sep) === process.env.APP_USERNAME && decoded.slice(sep + 1) === process.env.APP_PASSWORD) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="HomeAI Pro"');
  return res.status(401).send('Authentication required');
});

app.use(express.static(path.join(__dirname, '../web'), { extensions: ['html'] }));
app.get('/api/health', (_req, res) => res.json({ ok: true, geminiConfigured: hasGemini, youtubeConfigured: hasYoutube, mqttConfigured: Boolean(process.env.MQTT_URL && process.env.MQTT_USERNAME && process.env.MQTT_PASSWORD) }));

const mqttReady = Boolean(process.env.MQTT_URL && process.env.MQTT_USERNAME && process.env.MQTT_PASSWORD);
let mqttClient;
if (mqttReady) {
  mqttClient = mqtt.connect(process.env.MQTT_URL, {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    clientId: `homeai-server-${Math.random().toString(16).slice(2)}`,
    clean: true, reconnectPeriod: 3000, connectTimeout: 10000,
    rejectUnauthorized: true
  });
  mqttClient.on('error', err => console.error('MQTT error:', err.message));
}

const applianceMap = {
  'light 1': 0, 'first light': 0, 'living room light': 0,
  'fan': 1, 'light 2': 2, 'second light': 2,
  'appliance 4': 3, 'fourth appliance': 3
};
function extractDevice(text) {
  const s = text.toLowerCase();
  return Object.keys(applianceMap).sort((a,b) => b.length-a.length).find(k => s.includes(k));
}
function parseSafeDeviceCommand(text) {
  const s = text.toLowerCase();
  if (/(turn|switch|shut).*(everything|all).*(off)|\ball off\b|saare.*(band|off)|sab.*(band|off)/.test(s)) return { kind: 'alloff' };
  const device = extractDevice(s);
  if (!device) return null;
  const on = /\b(on|start|enable)\b|chala do|jala do/.test(s);
  const off = /\b(off|stop|disable)\b|band kar|bujha do/.test(s);
  if (on === off) return null;
  return { kind: 'relay', id: applianceMap[device], state: on };
}
function publishDeviceCommand(command) {
  if (!mqttClient || !mqttClient.connected) throw new Error('Smart-home MQTT connection is not ready.');
  const payload = command.kind === 'alloff' ? { action: 'alloff' } : { action: 'relay', id: command.id, state: command.state };
  mqttClient.publish(`${prefix}/cmd`, JSON.stringify(payload), { qos: 1, retain: false });
}

app.post('/api/device', (req, res) => {
  const text = String(req.body?.command || '').slice(0, 300);
  const command = parseSafeDeviceCommand(text);
  if (!command) return res.status(400).json({ error: 'I could not match a safe, specific appliance command.' });
  try { publishDeviceCommand(command); res.json({ ok: true, command }); }
  catch (e) { res.status(503).json({ error: e.message }); }
});

app.post('/api/music-search', async (req, res) => {
  const query = String(req.body?.query || '').trim().slice(0, 160);
  if (!query) return res.status(400).json({ error: 'Enter a song or music mood.' });
  if (!hasYoutube) return res.status(503).json({ error: 'YouTube search is not configured. Add YOUTUBE_API_KEY in backend/.env.' });
  try {
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.search = new URLSearchParams({ part: 'snippet', q: query, type: 'video', videoCategoryId: '10', maxResults: '8', safeSearch: 'moderate', key: process.env.YOUTUBE_API_KEY }).toString();
    const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
    const data = await response.json();
    if (!response.ok) return res.status(502).json({ error: data?.error?.message || 'YouTube search failed.' });
    res.json({ items: (data.items || []).filter(x => x.id?.videoId).map(x => ({ id: x.id.videoId, title: x.snippet?.title || 'YouTube video', channel: x.snippet?.channelTitle || '' })) });
  } catch (e) { res.status(502).json({ error: 'Could not reach YouTube search service.' }); }
});

app.post('/api/chat', async (req, res) => {
  if (!hasGemini) return res.status(503).json({ error: 'Gemini is not configured. Add GEMINI_API_KEY in backend/.env.' });
  const message = String(req.body?.message || '').trim().slice(0, 2000);
  const language = req.body?.language === 'hinglish' ? 'Hinglish' : 'English';
  const history = Array.isArray(req.body?.history) ? req.body.history.slice(-10).map(m => ({ role: m.role === 'model' ? 'model' : 'user', parts: [{ text: String(m.text || '').slice(0, 1200) }] })) : [];
  if (!message) return res.status(400).json({ error: 'Message is empty.' });
  const deviceCommand = parseSafeDeviceCommand(message);
  if (deviceCommand) {
    try {
      publishDeviceCommand(deviceCommand);
      const reply = language === 'Hinglish' ? 'Done! Command smart-home controller ko bhej diya.' : 'Done! I sent that command to your smart-home controller.';
      return res.json({ reply, action: { type: 'device', ...deviceCommand } });
    } catch (e) { return res.status(503).json({ reply: language === 'Hinglish' ? 'Controller abhi connected nahi hai.' : 'The smart-home controller is not connected right now.', error: e.message }); }
  }
  const system = `You are HomeAI, a warm, natural personal voice assistant. Reply in ${language}. If Hinglish, use casual Roman-script Hindi mixed with English, not Devanagari. Keep spoken replies concise and friendly. You can discuss music and smart homes, but do not claim you played music or controlled hardware unless the app reports that action. If the user asks to play a named song, music by mood/genre, or trending music, respond with exactly one line beginning MUSIC_SEARCH: followed by a useful YouTube search query, then optionally a short friendly sentence on the next line. Examples: MUSIC_SEARCH: Kesariya official song; MUSIC_SEARCH: trending romantic Hindi songs India; MUSIC_SEARCH: trending party songs India. If they say only 'play music' with no genre/title, ask which song or mood they want instead of searching. Never invent live trend rankings; the app searches YouTube results. Do not provide relay commands as tool instructions; the app handles explicit safe appliance commands separately.`;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(process.env.GEMINI_MODEL || 'gemini-2.5-flash')}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
    const contents = [...history, { role: 'user', parts: [{ text: message }] }];
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { temperature: 0.7, maxOutputTokens: 250 } }), signal: AbortSignal.timeout(20000) });
    const data = await response.json();
    if (!response.ok) return res.status(response.status === 429 ? 429 : 502).json({ error: data?.error?.message || 'Gemini request failed.' });
    const reply = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
    const match = reply.match(/(?:^|\n)MUSIC_SEARCH:\s*(.+)/i);
    res.json({ reply: reply.replace(/(?:^|\n)MUSIC_SEARCH:\s*.+/i, '').trim() || (language === 'Hinglish' ? 'Haan, batao kya help chahiye?' : 'Sure, how can I help?'), musicQuery: match?.[1]?.trim() || null });
  } catch (e) { res.status(502).json({ error: 'Could not reach Gemini. Check network and API configuration.' }); }
});

app.listen(port, () => console.log(`HomeAI Pro listening on port ${port}`));
