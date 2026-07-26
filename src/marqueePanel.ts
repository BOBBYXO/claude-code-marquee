import * as vscode from 'vscode';
import * as path from 'path';
import { ClaudeState } from './stateMachine';

interface StateConfig {
    label: string;
    color: string;     // 主色
    glow: string;      // 发光色
    animation: 'flow' | 'rotate' | 'breathe' | 'flicker' | 'dim';
}

const STATE_CONFIG: Record<ClaudeState, StateConfig> = {
    THINKING:      { label: '思考中',   color: '#3b82f6', glow: 'rgba(59,130,246,0.7)',  animation: 'flow' },
    TOOL_RUNNING:  { label: '执行工具', color: '#f59e0b', glow: 'rgba(245,158,11,0.7)',  animation: 'rotate' },
    WAITING_INPUT: { label: '等待输入', color: '#22c55e', glow: 'rgba(34,197,94,0.6)',   animation: 'breathe' },
    ERROR:         { label: '出错',     color: '#ef4444', glow: 'rgba(239,68,68,0.8)',   animation: 'flicker' },
    IDLE:          { label: '空闲',     color: '#64748b', glow: 'rgba(100,116,139,0.3)', animation: 'dim' },
};

export class MarqueePanel implements vscode.Disposable {
    private panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private _onDisposed = new vscode.EventEmitter<void>();
    readonly onDisposed = this._onDisposed.event;

    constructor(private context: vscode.ExtensionContext) {
        this.panel = vscode.window.createWebviewPanel(
            'claudeCodeMarquee',
            'Claude Code 跑马灯',
            vscode.ViewColumn.Two,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))],
            },
        );
        this.panel.webview.html = this.getHtml();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        // 初始空闲
        this.update('IDLE', '等待 Claude Code 会话');
    }

    reveal(): void {
        this.panel.reveal(vscode.ViewColumn.Two, true);
    }

    update(state: ClaudeState, detail?: string): void {
        const cfg = STATE_CONFIG[state];
        this.panel.webview.postMessage({ state, detail, ...cfg });
    }

    dispose(): void {
        this._onDisposed.fire();
        this.panel.dispose();
        while (this.disposables.length) {
            const d = this.disposables.pop();
            d?.dispose();
        }
    }

    private getHtml(): string {
        const nonce = getNonce();
        const csp = [
            `default-src 'none'`,
            `style-src 'nonce-${nonce}'`,
            `script-src 'nonce-${nonce}'`,
        ].join('; ');

        return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style nonce="${nonce}">
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
        height: 100vh; display: flex; flex-direction: column;
        justify-content: center; align-items: center;
        background: #0d1117; color: #c9d1d9;
        font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
        overflow: hidden;
    }
    .stage {
        width: 80%; max-width: 640px;
        display: flex; flex-direction: column; align-items: center; gap: 28px;
    }
    .lamp {
        width: 100%; height: 56px; border-radius: 28px;
        position: relative; overflow: hidden;
        background: #161b22;
        box-shadow: inset 0 0 8px rgba(0,0,0,0.6);
    }
    .strip { position: absolute; inset: 0; display: flex; }
    .seg {
        flex: 1; height: 100%;
        background: var(--color);
        opacity: 0.15;
        transition: opacity 0.3s, background 0.4s;
    }
    /* 流动: 亮带从左扫到右 */
    .strip.flow .seg { animation: flow 1.6s linear infinite; }
    @keyframes flow {
        0%, 100% { opacity: 0.12; }
        50% { opacity: 1; filter: brightness(1.4); }
    }
    .strip.flow .seg:nth-child(1){ animation-delay: 0s; }
    .strip.flow .seg:nth-child(2){ animation-delay: .1s; }
    .strip.flow .seg:nth-child(3){ animation-delay: .2s; }
    .strip.flow .seg:nth-child(4){ animation-delay: .3s; }
    .strip.flow .seg:nth-child(5){ animation-delay: .4s; }
    .strip.flow .seg:nth-child(6){ animation-delay: .5s; }
    .strip.flow .seg:nth-child(7){ animation-delay: .6s; }
    .strip.flow .seg:nth-child(8){ animation-delay: .7s; }
    /* 旋转: 顺时针转一圈亮 */
    .strip.rotate .seg { animation: rotate 1.2s linear infinite; }
    @keyframes rotate {
        0% { opacity: 0.1; } 50% { opacity: 1; } 100% { opacity: 0.1; }
    }
    .strip.rotate .seg:nth-child(1){ animation-delay: 0s; }
    .strip.rotate .seg:nth-child(2){ animation-delay: .15s; }
    .strip.rotate .seg:nth-child(3){ animation-delay: .30s; }
    .strip.rotate .seg:nth-child(4){ animation-delay: .45s; }
    .strip.rotate .seg:nth-child(5){ animation-delay: .60s; }
    .strip.rotate .seg:nth-child(6){ animation-delay: .75s; }
    .strip.rotate .seg:nth-child(7){ animation-delay: .90s; }
    .strip.rotate .seg:nth-child(8){ animation-delay: 1.05s; }
    /* 呼吸: 整体明暗 */
    .strip.breathe .seg { opacity: 1; animation: breathe 2.2s ease-in-out infinite; }
    @keyframes breathe { 0%,100% { opacity: 0.25; } 50% { opacity: 0.85; } }
    /* 闪烁 */
    .strip.flicker .seg { opacity: 1; animation: flicker 0.5s steps(2) infinite; }
    @keyframes flicker { 0%,49% { opacity: 1; } 50%,100% { opacity: 0.15; } }
    /* 空闲暗光 */
    .strip.dim .seg { opacity: 0.18; }

    .lamp.glow { box-shadow: 0 0 24px var(--glow), inset 0 0 8px rgba(0,0,0,0.6); }

    .status {
        display: flex; align-items: center; gap: 14px;
        font-size: 20px; font-weight: 600;
    }
    .dot { width: 14px; height: 14px; border-radius: 50%; background: var(--color); box-shadow: 0 0 12px var(--glow); }
    .detail { font-size: 14px; color: #8b949e; font-weight: 400; margin-top: 6px; min-height: 18px; }
    .hint { margin-top: 18px; font-size: 12px; color: #484f58; }
</style>
</head>
<body>
    <div class="stage">
        <div class="lamp" id="lamp">
            <div class="strip dim" id="strip">
                <div class="seg"></div><div class="seg"></div><div class="seg"></div><div class="seg"></div>
                <div class="seg"></div><div class="seg"></div><div class="seg"></div><div class="seg"></div>
            </div>
        </div>
        <div class="status">
            <span class="dot" id="dot"></span>
            <span id="label">空闲</span>
        </div>
        <div class="detail" id="detail">等待 Claude Code 会话</div>
    </div>
    <div class="hint">监听 ~/.claude/projects/ · 零侵入</div>

<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const lamp = document.getElementById('lamp');
    const strip = document.getElementById('strip');
    const dot = document.getElementById('dot');
    const label = document.getElementById('label');
    const detail = document.getElementById('detail');
    const ANIMS = ['flow','rotate','breathe','flicker','dim'];

    window.addEventListener('message', e => {
        const m = e.data;
        if (!m || !m.state) return;
        // 颜色
        document.documentElement.style.setProperty('--color', m.color);
        document.documentElement.style.setProperty('--glow', m.glow);
        // 灯带: 重置动画类
        strip.className = 'strip ' + m.animation;
        // 给每个 seg 上色
        strip.querySelectorAll('.seg').forEach(s => s.style.background = m.color);
        // 发光
        lamp.classList.add('glow');
        lamp.style.setProperty('--glow', m.glow);
        // 文案
        label.textContent = m.label;
        detail.textContent = m.detail || '';
        dot.style.background = m.color;
    });
</script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
