#!/usr/bin/env node
// Добыча видео и сборка страницы разбора. Подробности — в .claude/commands/razbor.md
//   fetch <url|файл> [--no-frames] [--visual]  метаданные, расшифровка, кадры в .work/<id>/
//                                          (нет субтитров или свой файл — речь распознаёт Whisper на этом Mac)
//   pick <id> <папка> <сек|mm:ss ...>      копирует выбранные кадры в Razbor/<папка>/img/
//   save <черновик.md> <папка>             кладёт черновик в Razbor/<папка>/razbor.md и собирает страницу
//   render <папка>                         собирает Razbor/<папка>/page.html из razbor.md
//   clean <id>                             удаляет .work/<id>/
//   backup                                 копия tasks.md в .backups/, хранит последние 20

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORK = path.join(ROOT, '.work');
const FONT = '/System/Library/Fonts/Menlo.ttc';
const KEEP_BACKUPS = 20;
// Фоновый Claude пишет черновик сюда, а save переносит его в Razbor/. Так запись проходит без подтверждений,
// даже если в пути к проекту есть папка с точкой в конце имени (Claude Code считает такой путь подозрительным).
export const DRAFTS = path.join(os.tmpdir(), 'razbor-drafts');
const WHISPER_MODEL = path.join(os.homedir(), '.local/share/whisper-models/ggml-large-v3-turbo.bin');

function die(message) {
  console.error(`Ошибка: ${message}`);
  process.exit(1);
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) die(`не запустился ${cmd}: ${r.error.message}`);
  return r;
}

function safeName(name, what) {
  if (!name || name.includes('/') || name.startsWith('.')) die(`плохое имя (${what}): ${name}`);
  return name;
}

function workDir(id) {
  const dir = path.join(WORK, safeName(id, 'id'));
  if (!fs.existsSync(dir)) die(`нет временной папки ${dir}, сначала fetch`);
  return dir;
}

function clock(total) {
  const s = Math.floor(total);
  const pad = (n) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

function toSeconds(value) {
  const parts = String(value).split(':').map(Number);
  if (parts.some(Number.isNaN)) return NaN;
  return parts.reduce((sum, n) => sum * 60 + n, 0);
}

// --- fetch ---

function chooseSubtitles(info) {
  const manual = Object.keys(info.subtitles || {}).filter((k) => k !== 'live_chat');
  const auto = info.automatic_captions || {};
  const origAuto = Object.keys(auto).find((k) => k.endsWith('-orig'));
  const lang = info.language || origAuto?.replace(/-orig$/, '');

  if (lang) {
    const key = manual.find((k) => k === lang || k.startsWith(`${lang}-`));
    if (key) return { key, kind: 'manual' };
  } else if (manual.length === 1) {
    return { key: manual[0], kind: 'manual' };
  }
  if (origAuto) return { key: origAuto, kind: 'auto' };
  if (lang && auto[lang]) return { key: lang, kind: 'auto' };
  return null;
}

function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

// Автосубтитры YouTube повторяют строки в соседних титрах, поэтому сверяем с последними выданными.
function vttToTranscript(vtt) {
  const out = [];
  const recent = [];
  let groupStart = null;
  let words = [];
  const flush = () => {
    if (words.length) out.push(`[${clock(groupStart)}] ${words.join(' ')}`);
    words = [];
    groupStart = null;
  };

  for (const cue of vtt.split(/\r?\n\r?\n/)) {
    const lines = cue.split(/\r?\n/);
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const start = toSeconds(lines[at].split('-->')[0].trim());
    for (const raw of lines.slice(at + 1)) {
      const text = decodeEntities(raw.replace(/<[^>]+>/g, '')).trim();
      if (!text || recent.includes(text)) continue;
      recent.push(text);
      if (recent.length > 4) recent.shift();
      if (groupStart === null) groupStart = start;
      words.push(text);
    }
    if (groupStart !== null && start - groupStart >= 20) flush();
  }
  flush();
  return out.join('\n') + '\n';
}

function fetchSubtitles(url, dir, choice) {
  const flag = choice.kind === 'manual' ? '--write-subs' : '--write-auto-subs';
  const r = run('yt-dlp', [
    '--no-warnings', '--no-playlist', '--skip-download', flag,
    '--sub-langs', choice.key, '--sub-format', 'vtt',
    '-o', path.join(dir, 'subs.%(ext)s'), url,
  ]);
  const file = fs.readdirSync(dir).find((f) => f.endsWith('.vtt'));
  if (!file) {
    const limited = /429/.test(r.stderr);
    return { error: limited ? 'YouTube ограничил запросы (429)' : r.stderr.trim().slice(-300) || 'файл субтитров не появился' };
  }
  const transcript = vttToTranscript(fs.readFileSync(path.join(dir, file), 'utf8'));
  fs.writeFileSync(path.join(dir, 'transcript.txt'), transcript);
  fs.rmSync(path.join(dir, file));
  return { file: 'transcript.txt', language: choice.key, kind: choice.kind, lines: transcript.trim().split('\n').length };
}

function downloadVideo(url, dir) {
  // 720p, а не 360–480p: иначе кадр шириной 1280 получается растянутым. Со звуком — он нужен, если субтитров нет.
  const dl = run('yt-dlp', [
    '--no-warnings', '--no-playlist',
    '-f', 'bv*[height<=720]+ba/b[height<=720]/b',
    '-o', path.join(dir, 'video.%(ext)s'), url,
  ]);
  const video = fs.readdirSync(dir).find((f) => f.startsWith('video.') && !f.endsWith('.part'));
  if (!video) return { error: /429/.test(dl.stderr) ? 'YouTube ограничил запросы (429)' : dl.stderr.trim().slice(-300) || 'видео не скачалось' };
  return { file: path.join(dir, video) };
}

// Речь распознаётся локально: whisper-cli из Homebrew и модель large-v3-turbo.
function transcribe(video, dir) {
  if (!fs.existsSync(WHISPER_MODEL)) return { error: `нет модели распознавания речи: ${WHISPER_MODEL}` };
  const wav = path.join(dir, 'audio.wav');
  const ff = run('ffmpeg', ['-hide_banner', '-y', '-i', video, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
  if (ff.status !== 0 || !fs.existsSync(wav)) return { error: /does not contain any stream|matches no streams/.test(ff.stderr) ? 'в видео нет звука' : ff.stderr.trim().slice(-300) };
  const threads = String(Math.max(4, Math.min(8, os.cpus().length - 2)));
  const w = run('whisper-cli', ['-m', WHISPER_MODEL, '-l', 'auto', '-t', threads, '-f', wav, '-ovtt', '-of', path.join(dir, 'whisper')]);
  fs.rmSync(wav, { force: true });
  const vtt = path.join(dir, 'whisper.vtt');
  if (w.status !== 0 || !fs.existsSync(vtt)) return { error: w.stderr.trim().slice(-300) || 'распознавание речи не удалось' };
  const transcript = vttToTranscript(fs.readFileSync(vtt, 'utf8'));
  fs.rmSync(vtt);
  const lines = transcript.trim() ? transcript.trim().split('\n').length : 0;
  if (!lines) return { error: 'речь в видео не найдена' };
  fs.writeFileSync(path.join(dir, 'transcript.txt'), transcript);
  const language = w.stderr.match(/auto-detected language: (\w+)/)?.[1] || null;
  return { file: 'transcript.txt', language, kind: 'whisper', note: 'распознано автоматически, в именах и терминах возможны ошибки', lines };
}

function extractFrames(input, dir, duration, visual) {
  const framesDir = path.join(dir, 'frames');
  const sheetsDir = path.join(dir, 'sheets');
  fs.mkdirSync(framesDir, { recursive: true });
  fs.mkdirSync(sheetsDir, { recursive: true });

  // Кадр берём при смене сцены и не реже чем раз в period секунд.
  const threshold = visual ? 0.1 : 0.2;
  const gap = visual ? Math.max(2, duration / 400) : Math.max(4, duration / 200);
  const period = visual ? 30 : 60;
  const select = `eq(n,0)+gt(scene,${threshold})*gte(t-prev_selected_t,${gap.toFixed(1)})+gte(t-prev_selected_t,${period})`;
  const graph = [
    `[0:v]select='${select}',showinfo,split=2[a][b]`,
    `[a]scale='min(1280,iw)':-2[full]`,
    `[b]scale=400:-2,drawtext=fontfile=${FONT}:text='%{pts\\:hms}':x=8:y=8:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.75:boxborderw=5,tile=4x4:padding=4[sheet]`,
  ].join(';');
  const ff = run('ffmpeg', [
    '-hide_banner', '-y', '-i', input, '-filter_complex', graph,
    '-map', '[full]', '-fps_mode', 'vfr', '-q:v', '3', path.join(framesDir, 'c_%05d.jpg'),
    '-map', '[sheet]', '-fps_mode', 'vfr', '-q:v', '5', path.join(sheetsDir, 'sheet_%02d.jpg'),
  ]);
  const times = [...ff.stderr.matchAll(/Parsed_showinfo.*?pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
  const candidates = fs.readdirSync(framesDir).filter((f) => f.startsWith('c_')).sort();
  if (!candidates.length) return { error: ff.stderr.trim().slice(-300) || 'ffmpeg не выдал кадров' };
  if (times.length !== candidates.length) return { error: `кадров ${candidates.length}, а меток времени ${times.length}` };

  candidates.forEach((file, i) => {
    fs.renameSync(path.join(framesDir, file), path.join(framesDir, `s_${Math.floor(times[i])}.jpg`));
  });
  return { candidates: candidates.length, sheets: fs.readdirSync(sheetsDir).sort().map((f) => `sheets/${f}`) };
}

function probe(file) {
  const r = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:format_tags=title,creation_time', '-of', 'json', file]);
  if (r.status !== 0) die(`не похоже на видео: ${r.stderr.trim().slice(-200)}`);
  const format = JSON.parse(r.stdout).format || {};
  return { duration: Math.round(Number(format.duration) || 0), tags: format.tags || {} };
}

function fetchLocal(file, noFrames, visual) {
  const { duration, tags } = probe(file);
  const name = path.basename(file).replace(/\.[^.]+$/, '');
  const id = `file-${Date.now().toString(36)}`;
  const dir = path.join(WORK, id);
  fs.mkdirSync(dir, { recursive: true });
  const meta = {
    id,
    source: 'file',
    file: path.basename(file),
    title: tags.title || name.replace(/^[0-9a-z]{6,}-/, ''),
    url: '',
    author: null,
    published: tags.creation_time ? tags.creation_time.slice(0, 10) : null,
    duration,
    length: clock(duration),
    language: null,
    chapters: [],
    description: '',
  };
  meta.transcript = transcribe(file, dir);
  meta.frames = noFrames ? { skipped: true } : extractFrames(file, dir, duration, visual);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  const { description, chapters, ...summary } = meta;
  console.log(JSON.stringify({ ...summary, chapters: 0, work: path.relative(ROOT, dir) }, null, 2));
}

function cmdFetch(args) {
  const url = args.find((a) => !a.startsWith('--'));
  if (!url) die('нужна ссылка на видео или путь к файлу');
  const noFrames = args.includes('--no-frames');
  const visual = args.includes('--visual');
  if (!/^https?:\/\//.test(url)) {
    if (!fs.existsSync(url)) die(`файл не найден: ${url}`);
    return fetchLocal(path.resolve(url), noFrames, visual);
  }

  const dump = run('yt-dlp', ['--no-warnings', '--no-playlist', '--dump-json', '--skip-download', url]);
  if (dump.status !== 0) die(/429/.test(dump.stderr) ? 'YouTube ограничил запросы (429), подожди полчаса' : dump.stderr.trim().slice(-500));
  const info = JSON.parse(dump.stdout);

  const dir = path.join(WORK, safeName(info.id, 'id'));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const d = info.upload_date;
  const meta = {
    id: info.id,
    title: info.title,
    url: info.webpage_url || url,
    author: info.uploader || info.channel,
    channel: info.channel,
    published: d ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null,
    duration: info.duration,
    length: clock(info.duration || 0),
    language: info.language || null,
    chapters: (info.chapters || []).map((c) => ({ at: clock(c.start_time), title: c.title })),
    description: info.description,
  };

  const choice = chooseSubtitles(info);
  meta.transcript = choice ? fetchSubtitles(meta.url, dir, choice) : { error: 'у видео нет субтитров на языке оригинала' };
  const noSubs = Boolean(meta.transcript.error);
  const video = noFrames && !noSubs ? null : downloadVideo(meta.url, dir);
  if (noSubs) meta.transcript = video.error ? { error: `${meta.transcript.error}; ${video.error}` } : transcribe(video.file, dir);
  meta.frames = noFrames ? { skipped: true } : video.error ? { error: video.error } : extractFrames(video.file, dir, info.duration || 0, visual);
  if (video?.file) fs.rmSync(video.file, { force: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));

  const { description, chapters, ...summary } = meta;
  console.log(JSON.stringify({ ...summary, chapters: chapters.length, work: path.relative(ROOT, dir) }, null, 2));
}

// --- pick ---

function razborDir(folder) {
  return path.join(ROOT, 'Razbor', safeName(folder, 'папка'));
}

function cmdPick([id, folder, ...times]) {
  if (!id || !folder || !times.length) die('pick <id> <папка> <секунды или mm:ss ...>');
  const framesDir = path.join(workDir(id), 'frames');
  if (!fs.existsSync(framesDir)) die('кадров нет: fetch был запущен с --no-frames или видео не скачалось');
  const available = fs.readdirSync(framesDir).map((f) => Number(f.match(/^s_(\d+)\.jpg$/)?.[1])).filter(Number.isFinite);
  const img = path.join(razborDir(folder), 'img');
  fs.mkdirSync(img, { recursive: true });

  const picked = new Set();
  const missing = [];
  for (const t of times) {
    const want = toSeconds(t);
    const nearest = available.reduce((best, s) => (Math.abs(s - want) < Math.abs(best - want) ? s : best), Infinity);
    if (Math.abs(nearest - want) > 2) {
      missing.push(t);
      continue;
    }
    picked.add(nearest);
    fs.copyFileSync(path.join(framesDir, `s_${nearest}.jpg`), path.join(img, `s_${nearest}.jpg`));
  }
  console.log(JSON.stringify({ files: [...picked].sort((a, b) => a - b).map((s) => ({ file: `img/s_${s}.jpg`, at: clock(s) })), missing }, null, 2));
}

// --- render ---

function esc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(text) {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

export function parseFront(source) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error('в файле нет шапки между ---');
  const front = {};
  for (const line of match[1].split('\n')) {
    const at = line.indexOf(':');
    if (at > 0) front[line.slice(0, at).trim()] = line.slice(at + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return { front, text: match[2] };
}

export function parseRazbor(source) {
  const { front, text } = parseFront(source);
  const match = [null, null, text];
  const sections = {};
  for (const part of match[2].split(/^## /m).slice(1)) {
    const nl = part.indexOf('\n');
    const head = (nl < 0 ? part : part.slice(0, nl)).trim();
    sections[head] = nl < 0 ? '' : part.slice(nl + 1).trim();
  }
  return { front, sections };
}

function videoLink(url, seconds) {
  return esc(`${url}${url.includes('?') ? '&' : '?'}t=${seconds}`);
}

function timeLink(url, stamp) {
  if (!url) return `<span class="tc" data-t="${toSeconds(stamp)}">${esc(stamp)}</span>`;
  return `<a class="tc" href="${videoLink(url, toSeconds(stamp))}">${esc(stamp)}</a>`;
}

const IMAGE_RE = /^!\[(.*?)\]\((.+?)\)$/;
const STAMP_RE = /^(\d{1,2}:\d{2}(?::\d{2})?)\s*[—–-]\s*(.*)$/;

function figure(line, url) {
  const [, alt, src] = line.match(IMAGE_RE);
  const parts = alt.match(STAMP_RE);
  const caption = parts ? `${timeLink(url, parts[1])} ${inline(parts[2])}` : inline(alt);
  return `<figure><button class="shot" type="button" aria-label="Увеличить кадр"><img src="${esc(src)}" alt="${esc(alt)}" loading="lazy"></button><figcaption>${caption}</figcaption></figure>`;
}

function blocks(text, url) {
  const html = [];
  const lines = text.split('\n');
  let i = 0;
  const takeWhile = (test) => {
    const taken = [];
    while (i < lines.length && test(lines[i].trim())) taken.push(lines[i++].trim());
    return taken;
  };

  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) {
      i++;
    } else if (IMAGE_RE.test(line)) {
      const shots = takeWhile((l) => IMAGE_RE.test(l));
      html.push(`<div class="shots${shots.length > 1 ? ' shots-grid' : ''}">${shots.map((s) => figure(s, url)).join('')}</div>`);
    } else if (line.startsWith('>')) {
      const quote = takeWhile((l) => l.startsWith('>')).map((l) => l.replace(/^>\s?/, '')).join(' ');
      html.push(/^Пропущено\s/.test(quote) ? `<p class="skip">${inline(quote)}</p>` : `<blockquote>${inline(quote)}</blockquote>`);
    } else if (/^- /.test(line)) {
      html.push(`<ul>${takeWhile((l) => /^- /.test(l)).map((l) => `<li>${inline(l.slice(2))}</li>`).join('')}</ul>`);
    } else if (/^\d+\. /.test(line)) {
      html.push(`<ol>${takeWhile((l) => /^\d+\. /.test(l)).map((l) => `<li>${inline(l.replace(/^\d+\. /, ''))}</li>`).join('')}</ol>`);
    } else {
      const para = takeWhile((l) => l && !IMAGE_RE.test(l) && !l.startsWith('>') && !/^- /.test(l) && !/^\d+\. /.test(l));
      html.push(`<p>${inline(para.join(' '))}</p>`);
    }
  }
  return html.join('\n');
}

function numbered(text, prefix) {
  const items = text.split('\n').map((l) => l.trim()).filter((l) => /^\d+\. /.test(l));
  return `<ol class="numbered">${items.map((l) => {
    const [, n, rest] = l.match(/^(\d+)\. (.*)$/);
    const tag = rest.match(/^\[(.+?)\]\s*(.*)$/);
    const body = tag ? `<span class="tag">${esc(tag[1])}</span> ${inline(tag[2])}` : inline(rest);
    return `<li><span class="num">${prefix}${n}</span><div>${body}</div></li>`;
  }).join('')}</ol>`;
}

function facts(text) {
  const rows = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ')).map((l) => {
    const body = l.slice(2);
    const at = body.indexOf(':');
    return at > 0 ? [body.slice(0, at), body.slice(at + 1).trim()] : ['', body];
  });
  return `<dl class="facts">${rows.map(([k, v]) => `<div><dt>${inline(k)}</dt><dd>${inline(v)}</dd></div>`).join('')}</dl>`;
}

function timeline(text, url) {
  const parts = text.split(/^### /m);
  const intro = parts.shift().trim();
  const items = parts.map((part, index) => {
    const nl = part.indexOf('\n');
    const head = (nl < 0 ? part : part.slice(0, nl)).trim();
    const body = nl < 0 ? '' : part.slice(nl + 1).trim();
    const stamp = head.match(STAMP_RE);
    return `<section class="block"><div class="block-side"><span class="num">б${index + 1}</span>${stamp ? timeLink(url, stamp[1]) : ''}</div><div class="block-main"><h3>${inline(stamp ? stamp[2] : head)}</h3>${blocks(body, url)}</div></section>`;
  });
  return `${intro ? blocks(intro, url) : ''}${items.join('\n')}`;
}

export function renderBody(source) {
  const { front, sections } = parseRazbor(source);
  const url = front.url || '';
  // «По делу» не может быть дольше самого видео: модель иногда пишет сюда проценты.
  const videoMin = front.length ? Math.max(1, Math.ceil(toSeconds(front.length) / 60)) : null;
  if (videoMin && Number(front.useful_min) > videoMin) front.useful_min = String(videoMin);

  const section = (head, html, cls = '') => (html ? `<section class="part ${cls}"><h2>${head}</h2>${html}</section>` : '');
  const stats = [
    [front.length, 'длина видео'],
    [front.useful_min && `${front.useful_min} мин`, 'по делу'],
    [front.read_min && `${front.read_min} мин`, 'время чтения'],
  ].filter(([value]) => value).map(([value, label]) => `<div><dd>${esc(value)}</dd><dt>${label}</dt></div>`).join('');

  const short = [
    stats && `<dl class="stats">${stats}</dl>`,
    sections['Суть'] ? `<section class="part lead">${blocks(sections['Суть'], url)}</section>` : '',
    section('Тезисы', sections['Тезисы'] && numbered(sections['Тезисы'], 'т')),
  ].filter(Boolean).join('\n');
  const detail = [
    section('Факты', sections['Факты'] && facts(sections['Факты'])),
    section('По порядку', sections['По порядку'] && timeline(sections['По порядку'], url), 'wide'),
    section('Чего не понял', sections['Чего не понял'] && blocks(sections['Чего не понял'], url)),
  ].filter(Boolean).join('\n');
  return { front, sections, short, detail, chatShort: chatText(front, sections, false), chatFull: chatText(front, sections, true) };
}

function plain(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => !IMAGE_RE.test(l))
    .map((l) => l.replace(/^>\s?/, ''))
    .join('\n')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1 ($2)')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function chatText(front, sections, full) {
  const length = [front.length && `Видео ${front.length}`, front.useful_min && `по делу ${front.useful_min} мин`].filter(Boolean).join(', ');
  const part = (head, text) => (text ? `${head}\n${plain(text)}` : '');
  const blocksText = (sections['По порядку'] || '').split(/^### /m).slice(1).map(plain).join('\n\n');
  return [
    [front.title, front.url, length].filter(Boolean).join('\n'),
    part('Суть', sections['Суть']),
    full && part('Факты', sections['Факты']),
    part('Тезисы', sections['Тезисы']),
    full && blocksText && `По порядку\n${blocksText}`,
    full && part('Чего не понял', sections['Чего не понял']),
  ].filter(Boolean).join('\n\n');
}

export const STATUS_LABELS = { new: 'Новое', read: 'Прочитал', useful: 'Полезно', skip: 'Мимо' };

export function writePage(folder) {
  const dir = razborDir(folder);
  const file = path.join(dir, 'razbor.md');
  if (!fs.existsSync(file)) throw new Error(`нет файла ${file}`);
  const { front, short, detail, chatShort, chatFull } = renderBody(fs.readFileSync(file, 'utf8'));

  const values = {
    TITLE: esc(front.title || folder),
    META: [front.author, front.published].filter(Boolean).map((m) => `<span>${esc(m)}</span>`).join(''),
    YOUTUBE: front.url ? `<a class="pill-link" href="${esc(front.url)}">${/loom\.com/.test(front.url) ? 'Loom' : 'YouTube'}</a>` : '',
    STATUS: esc(STATUS_LABELS[front.status] || STATUS_LABELS.new),
    SHORT: short,
    DETAIL: detail,
    CHAT_SHORT: esc(chatShort),
    CHAT_FULL: esc(chatFull),
  };
  const template = fs.readFileSync(path.join(ROOT, 'tools/template.html'), 'utf8');
  const page = template.replace(/\{\{(TITLE|META|YOUTUBE|STATUS|SHORT|DETAIL|CHAT_SHORT|CHAT_FULL)\}\}/g, (_, key) => values[key]);
  fs.writeFileSync(path.join(dir, 'page.html'), page);
  return path.relative(ROOT, path.join(dir, 'page.html'));
}

function cmdSave([draft, folder]) {
  if (!draft || !folder) die('save <черновик.md> <папка>');
  const source = path.resolve(draft);
  if (path.dirname(source) !== DRAFTS || !source.endsWith('.md') || !fs.existsSync(source)) die(`черновик не найден в ${DRAFTS}: ${draft}`);
  const dir = razborDir(folder);
  const target = path.join(dir, 'razbor.md');
  if (fs.existsSync(target)) die(`razbor.md уже есть в Razbor/${folder}, выбери другое имя папки`);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(source, target);
  fs.rmSync(source);
  console.log(`Сохранено: Razbor/${folder}/razbor.md`);
  console.log(writePage(folder));
}

function cmdRender([folder]) {
  if (!folder) die('render <папка>');
  console.log(writePage(folder));
}

// --- clean / backup ---

function cmdClean([id]) {
  if (!id) die('clean <id>');
  fs.rmSync(workDir(id), { recursive: true });
  console.log(`Удалено: .work/${id}`);
}

const TASKS_SKELETON = ['# Задачи', ...['Входящие', 'Сейчас', 'Дальше', 'Когда-нибудь', 'Сделано'].flatMap((s) => ['', `## ${s}`]), ''].join('\n');

export function backupTasks() {
  const dir = path.join(ROOT, '.backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(dir, `tasks-${stamp}.md`);
  const tasks = path.join(ROOT, 'tasks.md');
  if (!fs.existsSync(tasks)) fs.writeFileSync(tasks, TASKS_SKELETON);
  fs.copyFileSync(tasks, target);
  const old = fs.readdirSync(dir).filter((f) => /^tasks-.*\.md$/.test(f)).sort().slice(0, -KEEP_BACKUPS);
  old.forEach((f) => fs.rmSync(path.join(dir, f)));
  return path.relative(ROOT, target);
}

export { toSeconds, clock };

if (path.resolve(process.argv[1] || '') === import.meta.filename) {
  const [command, ...rest] = process.argv.slice(2);
  const commands = { fetch: cmdFetch, pick: cmdPick, save: cmdSave, render: cmdRender, clean: cmdClean, backup: () => console.log(backupTasks()) };
  if (!commands[command]) die('команды: fetch, pick, save, render, clean, backup');
  try {
    commands[command](rest);
  } catch (error) {
    die(error.message);
  }
}
