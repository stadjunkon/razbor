#!/usr/bin/env node
// Локальный интерфейс: http://localhost:3170. Работает с теми же файлами, что и команды Claude Code.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DRAFTS, backupTasks, parseFront, parseRazbor, renderBody, toSeconds, writePage } from './razbor.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const RAZBOR = path.join(ROOT, 'Razbor');
const KOPILKA = path.join(ROOT, 'Kopilka');
const TASKS = path.join(ROOT, 'tasks.md');
const JOBS_FILE = path.join(ROOT, '.work', 'jobs.json');
const PORT = 3170;
const TASKS_DIR = path.join(ROOT, 'Tasks');
const ALLOWED_HOSTS = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];
const KINDS = ['инсайт', 'приём', 'референс', 'сервис', 'полезное', 'инструкция', 'товар', 'разбор'];
const MODES = ['бегло', 'обычно', 'подробно', 'визуально'];
// Свои видео лежат во временной папке до конца разбора: туда фоновый Claude может смотреть без вопросов.
const UPLOADS = path.join(os.tmpdir(), 'razbor-uploads');
const VIDEO_EXT = ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'];
const MAX_UPLOAD = 8 * 1024 ** 3;
const SECTIONS = ['Входящие', 'Сейчас', 'Дальше', 'Когда-нибудь', 'Сделано'];
// Homebrew на Apple Silicon и Intel, плюс ~/.local/bin, куда ставится Claude Code.
const ENV = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${path.join(os.homedir(), '.local/bin')}:${process.env.PATH}` };

const MIME = { '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

class UserError extends Error {}

function today() {
  return new Date().toLocaleDateString('sv-SE');
}

function folderName(name) {
  if (typeof name !== 'string' || !name || name.includes('/') || name.startsWith('.') || name.startsWith('_')) throw new UserError('Неверное имя папки');
  return name;
}

function razborFile(folder) {
  const file = path.join(RAZBOR, folderName(folder), 'razbor.md');
  if (!fs.existsSync(file)) throw new UserError('Разбор не найден');
  return file;
}

function archive(baseDir, name) {
  const target = path.join(baseDir, '_archive');
  fs.mkdirSync(target, { recursive: true });
  fs.renameSync(path.join(baseDir, name), path.join(target, name));
}

// --- разборы ---

function listRazbors() {
  if (!fs.existsSync(RAZBOR)) return [];
  const items = [];
  for (const folder of fs.readdirSync(RAZBOR)) {
    const file = path.join(RAZBOR, folder, 'razbor.md');
    if (folder.startsWith('_') || folder.startsWith('.') || !fs.existsSync(file)) continue;
    try {
      const { front } = parseFront(fs.readFileSync(file, 'utf8'));
      items.push({ folder, ...front, frames: frames(folder), mtime: fs.statSync(file).mtimeMs, born: fs.statSync(file).birthtimeMs });
    } catch {
      items.push({ folder, title: folder, broken: true, frames: [], mtime: 0 });
    }
  }
  // Новые сверху: по дате в имени папки, внутри дня — по времени создания разбора.
  return items.sort((a, b) => b.folder.slice(0, 10).localeCompare(a.folder.slice(0, 10)) || (b.born || 0) - (a.born || 0));
}

function frames(folder) {
  const dir = path.join(RAZBOR, folder, 'img');
  if (!fs.existsSync(dir)) return [];
  const second = (f) => Number(f.match(/(\d+)/)?.[1] ?? 0);
  return fs.readdirSync(dir).filter((f) => /\.jpe?g$/.test(f)).sort((a, b) => second(a) - second(b));
}

function takenList(sections) {
  const lines = (sections['Забрано'] || '').split('\n');
  return lines.map((l) => l.match(/^- (.+?) → (задачи|копилка)(?:: (.*))?$/)).filter(Boolean).map((m) => ({
    source: m[1], dest: m[2], text: (m[3] || '').replace(/\s*\(Kopilka\/.+?\)$/, ''),
  }));
}

function allTopics() {
  return [...new Set(readKopilka().map((i) => i.topic).filter(Boolean))].sort();
}

function razborDetail(folder) {
  const { front, sections, short, detail, chatShort, chatFull } = renderBody(fs.readFileSync(razborFile(folder), 'utf8'));
  const prefix = `/files/Razbor/${encodeURIComponent(folder)}/img/`;
  const proposals = (sections['Предложения'] || '').split('\n').map((l) => l.trim().match(/^(\d+)\. (?:\[(.+?)\]\s*)?(.*)$/)).filter(Boolean).map((m) => ({ ref: `п${m[1]}`, tag: m[2] || null, text: m[3] }));
  return {
    folder, front, proposals, chatShort, chatFull,
    short: short.replaceAll('src="img/', `src="${prefix}`),
    detail: detail.replaceAll('src="img/', `src="${prefix}`),
    taken: takenList(sections),
    kinds: KINDS,
    topics: allTopics(),
  };
}

function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function slug(text) {
  const map = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  const latin = [...text.toLowerCase()].map((c) => map[c] ?? c).join('');
  return latin.replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 5).join('-') || 'zapis';
}

function yamlValue(value) {
  return `"${String(value).replace(/["\n]/g, ' ').trim()}"`;
}

function addKopilka({ text, kind, topic, from, url, img, sku, price, razbor }) {
  if (!text?.trim()) throw new UserError('Запись пустая');
  if (!KINDS.includes(kind)) throw new UserError('Неизвестный тип записи');
  fs.mkdirSync(KOPILKA, { recursive: true });
  const base = `${today()}-${slug(text)}`;
  let name = `${base}.md`;
  for (let i = 2; fs.existsSync(path.join(KOPILKA, name)); i++) name = `${base}-${i}.md`;
  const fields = [
    '---', 'type: kopilka', `kind: ${kind}`, `topic: ${yamlValue(topic || 'разное')}`, `date: ${today()}`,
    from && `from: ${yamlValue(from)}`, url && `url: ${yamlValue(url)}`, sku && `sku: ${yamlValue(sku)}`, price && `price: ${yamlValue(price)}`,
    img && `img: ${yamlValue(img)}`, razbor && `razbor: ${yamlValue(razbor)}`, '---',
  ].filter(Boolean);
  fs.writeFileSync(path.join(KOPILKA, name), `${fields.join('\n')}\n${text.trim()}\n`);
  return name;
}

function savePhoto(dataUrl, text) {
  const match = String(dataUrl).match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
  if (!match) throw new UserError('Фото должно быть в формате JPG, PNG или WebP');
  const dir = path.join(KOPILKA, 'img');
  fs.mkdirSync(dir, { recursive: true });
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  let name = `${today()}-${slug(text)}.${ext}`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${today()}-${slug(text)}-${i}.${ext}`;
  fs.writeFileSync(path.join(dir, name), Buffer.from(match[2], 'base64'));
  return `Kopilka/img/${name}`;
}

function putKopilka({ text, kind, topic, sku, price, photo }) {
  const url = String(text ?? '').match(/https?:\/\/\S+/)?.[0];
  const isProduct = kind === 'товар';
  const img = isProduct && photo ? savePhoto(photo, text || 'tovar') : undefined;
  return addKopilka({ text, kind, topic: oneLine(topic), url, sku: isProduct ? oneLine(sku) : undefined, price: isProduct ? oneLine(price) : undefined, img, from: 'вручную' });
}

function appendTaken(file, lines) {
  let source = fs.readFileSync(file, 'utf8').replace(/^\(пусто.*\)$/m, '').trimEnd();
  if (!/^## Забрано$/m.test(source)) source += '\n\n## Забрано';
  fs.writeFileSync(file, `${source}\n${lines.join('\n')}\n`.replace(/^status:.*$/m, 'status: useful'));
}

function sendPicked({ folder, items }) {
  const file = razborFile(folder);
  if (!Array.isArray(items) || !items.length) throw new UserError('Сначала отбери строки');
  for (const item of items) {
    if (!oneLine(item.text)) throw new UserError('Есть пустая строка: заполни её или убери');
    if (item.dest !== 'task' && item.dest !== 'kopilka') throw new UserError('Выбери, куда отправить каждую строку');
    if (item.dest === 'kopilka' && !KINDS.includes(item.kind)) throw new UserError('Выбери тип для записи в копилку');
    if (item.frame && !/^s_\d+\.jpe?g$/.test(item.frame)) throw new UserError('Неверный кадр');
  }

  const { front } = parseFront(fs.readFileSync(file, 'utf8'));
  const tasks = items.filter((i) => i.dest === 'task');
  const log = [];
  if (tasks.length) {
    backupTasks();
    const lines = fs.readFileSync(TASKS, 'utf8').split('\n');
    for (const item of tasks) {
      insertInSection(lines, 'Входящие', `- [ ] ${oneLine(item.text)} → [[Razbor/${folder}/razbor]]`);
      log.push(`- ${oneLine(item.source) || 'своё'} → задачи: ${oneLine(item.text)}`);
    }
    fs.writeFileSync(TASKS, lines.join('\n'));
  }
  const notes = items.filter((i) => i.dest === 'kopilka');
  for (const item of notes) {
    const seconds = Number.isFinite(item.seconds) && item.seconds >= 0 ? item.seconds : null;
    const url = front.url && seconds !== null ? `${front.url}${front.url.includes('?') ? '&' : '?'}t=${seconds}` : front.url;
    const hasFrame = item.frame && fs.existsSync(path.join(RAZBOR, folder, 'img', item.frame));
    const name = addKopilka({ text: item.text, kind: item.kind, topic: oneLine(item.topic) || front.topic, from: front.title, url, img: hasFrame ? `Razbor/${folder}/img/${item.frame}` : undefined, razbor: folder });
    log.push(`- ${oneLine(item.source) || 'своё'} → копилка: ${oneLine(item.text)} (Kopilka/${name})`);
  }
  appendTaken(file, log);
  writePage(folder);
  return { tasks: tasks.length, kopilka: notes.length };
}

function wholeToKopilka({ folder }) {
  const file = razborFile(folder);
  const { front, sections } = parseRazbor(fs.readFileSync(file, 'utf8'));
  if (takenList(sections).some((t) => t.source === 'весь разбор')) throw new UserError('Этот разбор уже лежит в копилке');
  const first = frames(folder)[0];
  const text = `${front.title}\n\n${(sections['Суть'] || '').trim()}`;
  const name = addKopilka({ text, kind: 'разбор', topic: front.topic, from: front.author, url: front.url, img: first ? `Razbor/${folder}/img/${first}` : undefined, razbor: folder });
  appendTaken(file, [`- весь разбор → копилка: ${oneLine(front.title)} (Kopilka/${name})`]);
  writePage(folder);
}

// Подборка — строка group: в шапке razbor.md. Пустое значение убирает разбор из подборки.
function writeGroup(folder, group) {
  const file = razborFile(folder);
  const source = fs.readFileSync(file, 'utf8');
  const end = source.indexOf('\n---', 4);
  if (!source.startsWith('---\n') || end < 0) throw new UserError('В разборе нет шапки');
  const head = source.slice(4, end).split('\n').filter((line) => !line.startsWith('group:'));
  const value = oneLine(group).slice(0, 80);
  if (value) head.push(`group: ${yamlValue(value)}`);
  fs.writeFileSync(file, `---\n${head.join('\n')}${source.slice(end)}`);
  writePage(folder);
}

function setRazborGroup({ folder, group }) {
  writeGroup(folder, group);
}

function setRazborStatus({ folder, status }) {
  if (!['new', 'read', 'useful', 'skip'].includes(status)) throw new UserError('Неверный статус');
  const file = razborFile(folder);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^status:.*$/m, `status: ${status}`));
  writePage(folder);
}

// --- задачи: правим строки точечно, чтобы не потерять то, что дописано руками ---

function insertInSection(lines, name, line) {
  const head = lines.indexOf(`## ${name}`);
  if (head < 0) throw new UserError(`Нет раздела «${name}»`);
  let end = lines.findIndex((l, i) => i > head && l.startsWith('## '));
  if (end < 0) end = lines.length;
  while (end - 1 > head && !lines[end - 1].trim()) end--;
  lines.splice(end, 0, line);
}

function readTasks() {
  if (!fs.existsSync(TASKS)) return SECTIONS.map((name) => ({ name, items: [] }));
  const result = SECTIONS.map((name) => ({ name, items: [] }));
  let current = null;
  fs.readFileSync(TASKS, 'utf8').split('\n').forEach((raw, line) => {
    const head = raw.match(/^## (.+)$/);
    if (head) current = result.find((s) => s.name === head[1].trim()) || null;
    const item = parseTaskLine(raw);
    if (item && current) current.items.push({ line, raw, ...item });
  });
  return result;
}

function parseTaskLine(raw) {
  const item = raw.match(/^- \[( |x)\] (.*)$/);
  if (!item) return null;
  const ref = item[2].match(/→ \[\[Razbor\/(.+?)\/razbor\]\]/);
  const file = item[2].match(/\[\[Tasks\/(.+?)\]\]/);
  const date = item[2].match(/\((\d{4}-\d{2}-\d{2})\)$/);
  const due = item[2].match(/📅\s*(\d{4}-\d{2}-\d{2})/);
  const text = item[2].replace(/\s*\[\[Tasks\/.+?\]\]/, '').replace(/\s*→ \[\[.+?\]\]/, '').replace(/\s*📅\s*\d{4}-\d{2}-\d{2}/, '').replace(/\s*\(\d{4}-\d{2}-\d{2}\)$/, '');
  return { text, done: item[1] === 'x', folder: ref?.[1] || null, file: file?.[1] || null, date: date?.[1] || null, due: due?.[1] || null };
}

function buildTaskLine({ text, done, folder, file, date, due }) {
  return `- [${done ? 'x' : ' '}] ${text}${due ? ` 📅 ${due}` : ''}${folder ? ` → [[Razbor/${folder}/razbor]]` : ''}${file ? ` [[Tasks/${file}]]` : ''}${date ? ` (${date})` : ''}`;
}

function updateTaskLine(line, raw, change) {
  const lines = fs.readFileSync(TASKS, 'utf8').split('\n');
  if (lines[line] !== raw) throw new UserError('Список изменился, обнови страницу');
  const next = buildTaskLine({ ...parseTaskLine(raw), ...change });
  if (next !== raw) {
    backupTasks();
    lines[line] = next;
    fs.writeFileSync(TASKS, lines.join('\n'));
  }
  return next;
}

function setTaskDue({ line, raw, due }) {
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new UserError('Неверная дата');
  return { raw: updateTaskLine(line, raw, { due: due || null }) };
}

// Описание, подшаги и комментарии лежат в Tasks/<имя>.md, в tasks.md только ссылка на этот файл.

function taskPath(name) {
  if (typeof name !== 'string' || !name || /[/\\]/.test(name) || name.startsWith('.')) throw new UserError('Неверное имя задачи');
  return path.join(TASKS_DIR, `${name}.md`);
}

function readTaskDetail(name) {
  const file = taskPath(name);
  const empty = { description: '', steps: [], comments: [], created: null };
  if (!fs.existsSync(file)) return empty;
  const { front, text } = parseFront(fs.readFileSync(file, 'utf8'));
  const parts = {};
  for (const part of text.split(/^## /m).slice(1)) {
    const nl = part.indexOf('\n');
    parts[(nl < 0 ? part : part.slice(0, nl)).trim()] = nl < 0 ? '' : part.slice(nl + 1).trim();
  }
  const lines = (head) => (parts[head] || '').split('\n').map((l) => l.trim());
  return {
    description: parts['Описание'] || '',
    steps: lines('Подшаги').map((l) => l.match(/^- \[( |x)\] (.*)$/)).filter(Boolean).map((m) => ({ text: m[2], done: m[1] === 'x' })),
    comments: lines('Комментарии').map((l) => l.match(/^- (\d{4}-\d{2}-\d{2}): (.*)$/)).filter(Boolean).map((m) => ({ date: m[1], text: m[2] })),
    created: front.created || null,
  };
}

function saveTaskDetail({ line, raw, file, description, steps, comments }) {
  const task = parseTaskLine(String(raw));
  if (!task) throw new UserError('Задача не найдена');
  const cleanSteps = (steps || []).map((s) => ({ text: oneLine(s.text), done: Boolean(s.done) })).filter((s) => s.text);
  const cleanComments = (comments || []).map((c) => ({ date: /^\d{4}-\d{2}-\d{2}$/.test(c.date) ? c.date : today(), text: oneLine(c.text) })).filter((c) => c.text);
  const body = String(description ?? '').replace(/^## /gm, '').trim();
  if (!file && !body && !cleanSteps.length && !cleanComments.length) return { raw, file: null };

  fs.mkdirSync(TASKS_DIR, { recursive: true });
  let name = file;
  if (!name) {
    name = `${today()}-${slug(task.text)}`;
    for (let i = 2; fs.existsSync(taskPath(name)); i++) name = `${today()}-${slug(task.text)}-${i}`;
  }
  const created = readTaskDetail(name).created || today();
  fs.writeFileSync(taskPath(name), [
    '---', 'type: task', `task: ${yamlValue(task.text)}`, `created: ${created}`, '---', '',
    '## Описание', body, '',
    '## Подшаги', ...cleanSteps.map((s) => `- [${s.done ? 'x' : ' '}] ${s.text}`), '',
    '## Комментарии', ...cleanComments.map((c) => `- ${c.date}: ${c.text}`), '',
  ].join('\n'));
  return { raw: updateTaskLine(line, raw, { file: name }), file: name };
}

function moveTask({ line, raw, to }) {
  if (!SECTIONS.includes(to)) throw new UserError('Нет такого раздела');
  const lines = fs.readFileSync(TASKS, 'utf8').split('\n');
  if (lines[line] !== raw) throw new UserError('Список изменился, обнови страницу');
  backupTasks();
  lines.splice(line, 1);
  let moved = raw.replace(/\s*\(\d{4}-\d{2}-\d{2}\)$/, '');
  moved = to === 'Сделано' ? `${moved.replace('- [ ]', '- [x]')} (${today()})` : moved.replace('- [x]', '- [ ]');
  insertInSection(lines, to, moved);
  fs.writeFileSync(TASKS, lines.join('\n'));
}

function addTask({ text }) {
  if (!text?.trim()) throw new UserError('Задача пустая');
  backupTasks();
  const lines = fs.readFileSync(TASKS, 'utf8').split('\n');
  insertInSection(lines, 'Входящие', `- [ ] ${text.replace(/\s+/g, ' ').trim()}`);
  fs.writeFileSync(TASKS, lines.join('\n'));
}

// --- копилка ---

function readKopilka() {
  if (!fs.existsSync(KOPILKA)) return [];
  const items = [];
  for (const file of fs.readdirSync(KOPILKA).filter((f) => f.endsWith('.md'))) {
    try {
      const { front, text } = parseFront(fs.readFileSync(path.join(KOPILKA, file), 'utf8'));
      items.push({ file, ...front, text: text.trim() });
    } catch {
      items.push({ file, kind: 'полезное', text: fs.readFileSync(path.join(KOPILKA, file), 'utf8').trim() });
    }
  }
  return items.sort((a, b) => b.file.localeCompare(a.file));
}

// --- очередь разборов ---

let jobs = [];
let child = null;
let loggedIn = false;

try {
  jobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')).map((j) => (j.status === 'running' ? { ...j, status: 'queued', step: null } : j));
} catch {
  jobs = [];
}

function saveJobs() {
  fs.mkdirSync(path.dirname(JOBS_FILE), { recursive: true });
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

function checkLogin() {
  return new Promise((resolve) => {
    execFile('claude', ['auth', 'status'], { env: ENV, timeout: 20000 }, (error, stdout) => {
      try {
        loggedIn = Boolean(JSON.parse(stdout).loggedIn);
      } catch {
        loggedIn = false;
      }
      resolve(loggedIn);
    });
  });
}

function cleanFocus(focus) {
  return String(focus || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function queueJob(job) {
  jobs = jobs.filter((j) => j.status !== 'done');
  const full = { status: 'queued', step: null, title: null, error: null, folder: null, created: Date.now(), ...job };
  jobs.push(full);
  saveJobs();
  pump();
  return full;
}

function dropUpload(job) {
  if (job.file) fs.rmSync(job.file, { force: true });
}

async function receiveUpload(req, query) {
  const original = path.basename(String(query.get('name') || ''));
  const ext = path.extname(original).toLowerCase();
  const mode = query.get('mode');
  if (!VIDEO_EXT.includes(ext)) throw new UserError('Нужен видеофайл: mp4, mov, m4v, webm, mkv или avi');
  if (!MODES.includes(mode)) throw new UserError('Неизвестный режим');
  const size = Number(req.headers['content-length']);
  if (!size) throw new UserError('Файл пустой');
  if (size > MAX_UPLOAD) throw new UserError('Файл больше 8 ГБ, такой не возьму');
  const id = Date.now().toString(36);
  const title = original.slice(0, -ext.length).trim() || 'Видео';
  // Без пробелов и кавычек: путь уходит в текст команды для Claude.
  const safe = title.replace(/[^\p{L}\p{N}.-]+/gu, '_').slice(0, 80);
  fs.mkdirSync(UPLOADS, { recursive: true });
  const file = path.join(UPLOADS, `${id}-${safe}${ext}`);
  try {
    await pipeline(req, fs.createWriteStream(file));
  } catch {
    fs.rmSync(file, { force: true });
    throw new UserError('Файл не загрузился до конца, попробуй ещё раз');
  }
  queueJob({ id, url: null, file, title, mode, focus: cleanFocus(query.get('focus')), group: oneLine(query.get('group')).slice(0, 80) });
  return { ok: true };
}

function addJob({ url, mode, focus, group }) {
  let parsed;
  try {
    parsed = new URL(String(url).trim());
  } catch {
    throw new UserError('Это не ссылка. Вставь адрес видео с YouTube');
  }
  const youtube = /(^|\.)(youtube\.com|youtu\.be)$/.test(parsed.hostname);
  const loom = /(^|\.)loom\.com$/.test(parsed.hostname) && /^\/(share|embed)\/[0-9a-f]{32}/.test(parsed.pathname);
  if (parsed.protocol !== 'https:' || !(youtube || loom)) throw new UserError('Сейчас разбираются видео с YouTube и Loom, а свои файлы — перетаскиванием');
  if (!MODES.includes(mode)) throw new UserError('Неизвестный режим');
  const job = queueJob({ id: Date.now().toString(36), url: parsed.href, mode, focus: cleanFocus(focus), group: oneLine(group).slice(0, 80) });
  execFile('yt-dlp', ['--no-warnings', '--no-playlist', '--skip-download', '--print', 'title', job.url], { env: ENV, timeout: 60000 }, (error, stdout) => {
    if (!error && stdout.trim()) {
      job.title = stdout.trim();
      saveJobs();
    }
  });
}

function stepFrom(tool) {
  const command = tool.input?.command || '';
  const file = tool.input?.file_path || '';
  if (command.includes('razbor.mjs fetch')) return /fetch\s+["']?https?:/.test(command) ? 'Скачиваю субтитры и кадры' : 'Распознаю речь и достаю кадры';
  if (command.includes('razbor.mjs pick')) return 'Отбираю кадры';
  if (command.includes('razbor.mjs save') || command.includes('razbor.mjs render')) return 'Собираю страницу';
  if (file.includes('sheet_')) return 'Смотрю кадры';
  if (file.includes('transcript.txt')) return 'Читаю расшифровку';
  if (file.endsWith('razbor.md') || file.includes('razbor-drafts')) return 'Пишу конспект';
  return null;
}

async function pump() {
  if (child) return;
  const job = jobs.find((j) => j.status === 'queued');
  if (!job) return;
  if (!(await checkLogin()) || child || job.status !== 'queued') return;

  const startedAt = Date.now();
  const focus = job.focus ? ` фокус: ${job.focus}` : '';
  job.status = 'running';
  job.step = 'Запускаю';
  job.error = null;
  saveJobs();

  fs.mkdirSync(DRAFTS, { recursive: true });
  child = spawn('claude', [
    '-p', `/razbor ${job.file || job.url} ${job.mode} черновики: ${DRAFTS}${focus}`,
    '--add-dir', DRAFTS,
    '--model', 'sonnet',
    '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Bash(node tools/razbor.mjs:*),Read,Write,Edit,Glob,Grep',
    '--output-format', 'stream-json', '--verbose',
  ], { cwd: ROOT, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });

  let buffer = '';
  let result = '';
  let stderr = '';
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-1000); });
  child.stdout.on('data', (data) => {
    buffer += data;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'result') result = event.result || event.subtype || '';
        for (const part of event.type === 'assistant' ? event.message?.content || [] : []) {
          const step = part.type === 'tool_use' ? stepFrom(part) : null;
          if (step) {
            job.step = step;
            saveJobs();
          }
        }
      } catch {
        // неполная или служебная строка потока
      }
    }
  });

  child.on('error', (error) => finish(job, startedAt, 1, error.message));
  child.on('close', (code) => finish(job, startedAt, code, result || stderr));
  child.on('exit', (code) => { if (job.cancelled) finish(job, startedAt, code, ''); });
}

// Папка разбора считается новой, если её страница собрана уже после старта этой задачи.
// Новый разбор — папка, где razbor.md создан после старта и уже собрана страница.
// Время изменения страницы не подходит: её пересобирают и у старых разборов.
function freshRazbor(startedAt) {
  const fresh = fs.readdirSync(RAZBOR).filter((folder) => {
    const file = path.join(RAZBOR, folder, 'razbor.md');
    return !folder.startsWith('_') && fs.existsSync(file) && fs.existsSync(path.join(RAZBOR, folder, 'page.html')) && fs.statSync(file).birthtimeMs >= startedAt;
  });
  return fresh.sort((a, b) => fs.statSync(path.join(RAZBOR, b, 'razbor.md')).birthtimeMs - fs.statSync(path.join(RAZBOR, a, 'razbor.md')).birthtimeMs)[0];
}

function finish(job, startedAt, code, output) {
  if (job.status !== 'running') return;
  child = null;
  if (job.cancelled) {
    job.status = 'cancelled';
    dropUpload(job);
    jobs = jobs.filter((j) => j !== job);
  } else {
    const created = code === 0 ? freshRazbor(startedAt) : null;
    if (created) {
      Object.assign(job, { status: 'done', step: null, folder: created });
      dropUpload(job);
      if (job.group) {
        try {
          writeGroup(created, job.group);
        } catch (error) {
          console.error('Подборка не записалась:', error.message);
        }
      }
    } else if (/not logged in|\/login/i.test(output)) {
      Object.assign(job, { status: 'queued', step: null });
      loggedIn = false;
    } else {
      Object.assign(job, { status: 'failed', step: null, error: String(output || `Код выхода ${code}`).trim().slice(-400) });
    }
  }
  saveJobs();
  if (loggedIn) pump();
}

function cancelJob(id) {
  const job = jobs.find((j) => j.id === id);
  if (!job) return;
  if (job.status === 'running' && child) {
    job.cancelled = true;
    job.step = 'Останавливаю';
    const running = child;
    running.kill();
    setTimeout(() => running.kill('SIGKILL'), 3000);
  } else {
    dropUpload(job);
    jobs = jobs.filter((j) => j !== job);
    saveJobs();
  }
}

function retryJob(id) {
  const job = jobs.find((j) => j.id === id && j.status === 'failed');
  if (!job) return;
  Object.assign(job, { status: 'queued', error: null });
  saveJobs();
  pump();
}

// Раз в 15 секунд: запускаем очередь, а без входа заново смотрим, не вошёл ли человек.
setInterval(() => {
  if (child) return;
  if (jobs.some((j) => j.status === 'queued')) pump();
  else if (!loggedIn) checkLogin();
}, 15000);

// Окно входа открывается в Терминале на этом же компьютере: пароль вводит сам человек.
function openLogin() {
  spawn('open', [path.join(ROOT, 'Войти в Claude.command')], { stdio: 'ignore', detached: true }).unref();
  return { ok: true };
}
checkLogin().then(() => pump());

// --- http ---

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function json(res, value) {
  send(res, 200, JSON.stringify(value ?? { ok: true }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (d) => {
      raw += d;
      if (raw.length > 16e6) reject(new UserError('Файл слишком большой'));
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        reject(new UserError('Неверный запрос'));
      }
    });
  });
}

function serveFile(res, relative) {
  const full = path.resolve(ROOT, relative);
  const inside = [RAZBOR, KOPILKA].some((dir) => full.startsWith(dir + path.sep));
  const type = MIME[path.extname(full).toLowerCase()];
  if (!inside || !type || !fs.existsSync(full)) return send(res, 404, 'Не найдено', 'text/plain; charset=utf-8');
  res.writeHead(200, { 'Content-Type': type });
  fs.createReadStream(full).pipe(res);
}

const routes = {
  '/api/jobs': addJob,
  '/api/send': sendPicked,
  '/api/razbor/whole': wholeToKopilka,
  '/api/razbor/status': setRazborStatus,
  '/api/razbor/group': setRazborGroup,
  '/api/razbor/archive': ({ folder }) => archive(RAZBOR, folderName(folder)),
  '/api/tasks/add': addTask,
  '/api/tasks/move': moveTask,
  '/api/tasks/due': setTaskDue,
  '/api/tasks/detail': saveTaskDetail,
  '/api/kopilka/add': putKopilka,
  '/api/kopilka/archive': ({ file }) => archive(KOPILKA, folderName(file)),
  '/api/jobs/cancel': ({ id }) => cancelJob(id),
  '/api/jobs/retry': ({ id }) => retryJob(id),
  '/api/login': openLogin,
};

const server = http.createServer(async (req, res) => {
  try {
    // Интерфейс управляет файлами и запускает Claude, поэтому отвечает только своей странице.
    if (!ALLOWED_HOSTS.includes(req.headers.host)) return send(res, 403, 'Запрещено', 'text/plain; charset=utf-8');
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);

    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && !ALLOWED_HOSTS.includes(origin.replace(/^http:\/\//, ''))) return send(res, 403, 'Запрещено', 'text/plain; charset=utf-8');
      if (pathname === '/api/upload') return json(res, await receiveUpload(req, url.searchParams));
      if (!routes[pathname]) return send(res, 404, '{}');
      if (!String(req.headers['content-type']).startsWith('application/json')) return send(res, 415, '{}');
      return json(res, (await routes[pathname](await readBody(req))) ?? null);
    }

    if (pathname === '/') return send(res, 200, fs.readFileSync(path.join(ROOT, 'tools/app.html')), MIME['.html']);
    if (pathname === '/page.css') {
      const css = fs.readFileSync(path.join(ROOT, 'tools/template.html'), 'utf8').match(/<style>([\s\S]*?)<\/style>/)[1];
      return send(res, 200, css, 'text/css; charset=utf-8');
    }
    if (pathname === '/api/state') {
      return json(res, { razbors: listRazbors(), jobs, loggedIn, counts: { kopilka: readKopilka().length, tasks: readTasks().filter((s) => s.name !== 'Сделано').reduce((n, s) => n + s.items.length, 0) } });
    }
    if (pathname === '/api/tasks') return json(res, readTasks());
    if (pathname.startsWith('/api/task-detail/')) return json(res, readTaskDetail(pathname.slice('/api/task-detail/'.length)));
    if (pathname === '/api/kopilka') return json(res, { items: readKopilka(), kinds: KINDS, topics: allTopics() });
    if (pathname.startsWith('/api/razbor/')) return json(res, razborDetail(pathname.slice('/api/razbor/'.length)));
    if (pathname.startsWith('/files/')) return serveFile(res, pathname.slice('/files/'.length));
    send(res, 404, 'Не найдено', 'text/plain; charset=utf-8');
  } catch (error) {
    if (!(error instanceof UserError)) console.error(error);
    send(res, error instanceof UserError ? 400 : 500, JSON.stringify({ error: error instanceof UserError ? error.message : 'Не получилось выполнить действие. Подробности в окне терминала' }));
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`Разбор открыт: http://localhost:${PORT}`));
