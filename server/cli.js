// 单次调用本机 Claude Code（claude -p），用登录的订阅额度，不需要 API Key。
// 和 agent.js 的区别：这里是“问一次、拿结果”的轻量调用，不给任何工具、不加载 MCP、不留会话，
// 可以和后台 Agent 任务同时进行。写脚本、AI 预审、AI 复盘都走这里。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { claudeToken } from './secrets.js';
import path from 'node:path';

export class AIError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function claudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const home = os.userInfo().homedir;
  const dirs = [...(process.env.PATH || '').split(path.delimiter), path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  return dirs.map((d) => path.join(d, 'claude')).find((p) => existsSync(p)) || 'claude';
}

// 要用本机登录的订阅账号：去掉会让 claude 改走 API Key 或别的服务地址的环境变量
// （从别的工具里启动工作台时，可能继承到这些变量）
export function cliEnv() {
  const env = { ...process.env, HOME: os.userInfo().homedir };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) delete env[k];
  // 「设置 → 连接」里填了长期令牌就用它；没填就用本机 claude 的登录状态
  const token = claudeToken();
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return env;
}

export function loginErrorMessage() {
  return claudeToken()
    ? '「设置 → 连接」里的 Claude 令牌无效或过期了：在终端运行 claude setup-token 重新生成，粘贴到那里'
    : '本机 Claude Code 没登录或登录失效了：在终端运行 claude 再输入 /login；想更稳就运行 claude setup-token，把令牌粘贴到「设置 → 连接」';
}

/**
 * 问 Claude 一次。
 * - model：系列别名（opus / sonnet / fable / haiku），Claude Code 自己解析成该系列最新版本
 * - effort：思考强度（low / medium / high / xhigh / max），不给就用本机 Claude Code 的设置
 * - images：要它看的图片（绝对路径）。给了就只开放读文件工具，并且只能读这些图片所在的目录
 * - schema：给了就要求按 JSON Schema 返回，结果在 structured 里
 * - onText：流式收到的文字增量
 * 返回 { text, structured, truncated, model }
 */
export function runClaude(prompt, { model = 'opus', effort, schema, onText, signal, cwd, images = [] } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AIError('cancelled', '已停止。'));
    const args = [
      '-p', prompt,
      '--model', model,
      ...(effort ? ['--effort', effort] : []),
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      // 不给任何工具，只要它直接回答；要看图时只给读文件
      '--tools', images.length ? 'Read' : '',
      ...(images.length ? ['--allowedTools', 'Read', ...[...new Set(images.map((f) => path.dirname(f)))].flatMap((d) => ['--add-dir', d])] : []),
      '--strict-mcp-config', // 不加载项目的 MCP 服务
      '--permission-mode', 'dontAsk',
      '--no-session-persistence',
      '--max-turns', String((schema ? 4 : 2) + images.length * 2),
      ...(schema ? ['--json-schema', JSON.stringify(schema)] : []),
    ];
    let proc;
    try {
      proc = spawn(claudeBin(), args, { cwd: cwd || os.tmpdir(), env: cliEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return reject(new AIError('no_cli', `启动 claude 失败：${err.message}。确认已安装 Claude Code，或在 .env 里设置 CLAUDE_BIN`));
    }

    let buf = '';
    let stderr = '';
    let result = null;
    let usedModel = null;
    let streamed = '';
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn(v);
    };
    const onAbort = () => {
      proc.kill('SIGTERM');
      done(reject, new AIError('cancelled', '已停止。'));
    };
    signal?.addEventListener('abort', onAbort);

    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === 'system' && ev.subtype === 'init' && ev.model) usedModel = ev.model;
        else if (ev.type === 'stream_event') {
          const e = ev.event;
          if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
            streamed += e.delta.text;
            onText?.(e.delta.text);
          }
        } else if (ev.type === 'result') result = ev;
      }
    });
    proc.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    proc.on('error', (err) =>
      done(reject, new AIError('no_cli', `启动 claude 失败：${err.message}。确认已安装 Claude Code，或在 .env 里设置 CLAUDE_BIN`)),
    );
    proc.on('close', (code) => {
      if (settled) return;
      const ok = result && !result.is_error && result.subtype === 'success';
      if (!ok) {
        const msg = result?.result || stderr.trim() || `claude 退出，代码 ${code}`;
        if (/authenticat|OAuth|login|401/i.test(msg)) return done(reject, new AIError('auth', loginErrorMessage()));
        if (/rate.?limit|usage limit|额度/i.test(msg)) return done(reject, new AIError('rate_limited', '订阅额度暂时用完了，过一会儿再试'));
        if (result?.subtype === 'error_max_turns') return done(reject, new AIError('max_turns', '没在限定轮数内给出结果，再试一次'));
        return done(reject, new AIError('cli_error', String(msg).slice(0, 300)));
      }
      const text = String(result.result ?? streamed ?? '');
      done(resolve, {
        text,
        structured: result.structured_output ?? null,
        truncated: result.stop_reason === 'max_tokens',
        model: usedModel,
      });
    });
  });
}
