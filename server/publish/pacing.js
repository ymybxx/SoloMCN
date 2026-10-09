import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_MAX_MS = 600;
const MAX_STEP_MS = 2000;
const TOTAL_BUDGET_MS = 6000;

// 额外的步骤间停顿，不代替页面状态等待，也不保证平台会如何识别自动化。
// 每次发布独立计算预算，避免话题较多时累积过长的等待。
export function createStepPause({ maxMs = process.env.XHS_STEP_PAUSE_MS, random = Math.random, wait = delay } = {}) {
  const value = maxMs == null || String(maxMs).trim() === '' ? DEFAULT_MAX_MS : Number(maxMs);
  const ceiling = Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), MAX_STEP_MS) : DEFAULT_MAX_MS;
  let remaining = TOTAL_BUDGET_MS;
  return async () => {
    if (!ceiling || !remaining) return;
    const ms = Math.min(remaining, Math.round(ceiling * (0.5 + random() * 0.5)));
    remaining -= ms;
    await wait(ms);
  };
}
