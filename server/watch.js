// 让 Claude “看”一条现成视频：Claude 不能直接播放视频，所以拆成它能看的两样东西——
// 1. 画面：按时长均匀截 24–36 帧，每帧左上角标时间，拼成几张缩略图（每张 4×3 格）
// 2. 声音：用本机的 whisper.cpp 把语音转成带时间点的文字（没装或没有人声就跳过）
// 结果交给生成发布信息的 Claude，连同人写的引导一起，写各平台的标题、简介、话题和封面提示词。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const FONT = ['/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Helvetica.ttc', '/Library/Fonts/Arial.ttf'].find((f) => fs.existsSync(f));
// 中文要用多语言模型（.en 结尾的只认英文），在 .env 里用 WHISPER_MODEL 指定模型文件；没配就跳过听写
const WHISPER_MODEL = [process.env.WHISPER_MODEL].find((f) => f && fs.existsSync(f));
const WHISPER_BIN = process.env.WHISPER_BIN || ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli'].find((f) => fs.existsSync(f));

const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file], { timeout: 20_000 });
  const j = JSON.parse(stdout);
  return { durationS: Math.round(Number(j.format?.duration || 0) * 10) / 10, width: j.streams?.[0]?.width || 0, height: j.streams?.[0]?.height || 0 };
}

async function sheets(file, dir, durationS) {
  const frames = path.join(dir, 'frames');
  fs.rmSync(frames, { recursive: true, force: true });
  fs.mkdirSync(frames, { recursive: true });
  const every = Math.max(2, Math.ceil(durationS / 36)); // 短视频每 2 秒一帧，长视频最多 36 帧
  const label = FONT ? `,drawtext=fontfile='${FONT}':text='%{pts\\:hms}':x=8:y=8:fontsize=26:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=6` : '';
  await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', `fps=1/${every},scale=360:-2${label}`, '-frames:v', '36', path.join(frames, 'f-%03d.jpg')], { timeout: 180_000 });
  const n = fs.readdirSync(frames).filter((f) => f.endsWith('.jpg')).length;
  if (!n) throw new Error('没截到画面');
  for (const f of fs.readdirSync(dir).filter((f) => /^sheet-\d+\.jpg$/.test(f))) fs.rmSync(path.join(dir, f));
  await run('ffmpeg', ['-v', 'error', '-y', '-framerate', '1', '-i', path.join(frames, 'f-%03d.jpg'), '-vf', 'tile=4x3:padding=6:color=black', path.join(dir, 'sheet-%02d.jpg')], { timeout: 120_000 });
  fs.rmSync(frames, { recursive: true, force: true });
  return { files: fs.readdirSync(dir).filter((f) => /^sheet-\d+\.jpg$/.test(f)).sort().map((f) => path.join(dir, f)), every, frames: n };
}

async function transcribe(file, dir) {
  if (!WHISPER_BIN || !WHISPER_MODEL) return { text: '', skipped: '本机没有 whisper.cpp 或多语言模型，跳过语音转文字' };
  const wav = path.join(dir, 'audio.wav');
  const out = path.join(dir, 'transcript');
  try {
    await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vn', '-ar', '16000', '-ac', '1', wav], { timeout: 120_000 });
  } catch {
    return { text: '', skipped: '视频里没有音轨' };
  }
  try {
    await run(WHISPER_BIN, ['-m', WHISPER_MODEL, '-l', 'auto', '-f', wav, '-oj', '-of', out, '-np'], { timeout: 20 * 60_000 });
    const segs = JSON.parse(fs.readFileSync(`${out}.json`, 'utf8')).transcription || [];
    const text = segs.map((s) => `[${mmss((s.offsets?.from || 0) / 1000)}] ${String(s.text || '').trim()}`).filter((l) => l.length > 8).join('\n');
    return { text: text.slice(0, 12000), skipped: text ? '' : '没听到人声' };
  } catch (err) {
    return { text: '', skipped: `语音转文字失败：${String(err.message).split('\n')[0].slice(0, 120)}` };
  } finally {
    fs.rmSync(wav, { force: true });
  }
}

/**
 * 看一条视频。dir 是放结果的目录（相对 root），返回的路径都相对 root。
 * { durationS, width, height, sheets: [...], every, frames, transcript, transcriptNote }
 */
export async function watchVideo({ root, mp4, dir }) {
  const file = path.resolve(root, mp4);
  const out = path.resolve(root, dir);
  fs.mkdirSync(out, { recursive: true });
  const info = await probe(file);
  const [s, t] = await Promise.all([sheets(file, out, info.durationS || 60), transcribe(file, out)]);
  return { ...info, sheets: s.files.map((f) => path.relative(root, f)), every: s.every, frames: s.frames, transcript: t.text, transcriptNote: t.skipped };
}
