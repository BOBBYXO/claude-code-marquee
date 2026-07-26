import * as fs from 'fs';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';
import { Disposable, ExtensionContext } from 'vscode';
import { WorkspaceState } from './sessionManager';

// 单窗多会话: 一个窗, 每个会话一行. 扩展只管 1 个进程 + 1 个汇总 state 文件.
export class WindowManager implements Disposable {
    private process: ChildProcess | null = null;
    private disposed = false;
    private readonly exePath: string;
    private readonly stateFile: string;
    private lastSerialized = '';

    constructor(context: ExtensionContext) {
        this.exePath = path.join(context.asAbsolutePath('.'), 'window', 'MarqueeWindow.exe');
        const storageDir = context.globalStorageUri.fsPath;
        try { fs.mkdirSync(storageDir, { recursive: true }); } catch { /* 已存在 */ }
        this.stateFile = path.join(storageDir, 'marquee-state.txt');
    }

    // 收到所有工作区状态, 写汇总文件 + 确保窗已启动
    // 只在"最近 10 分钟有活动"的会话才纳入显示并启动窗
    update(states: WorkspaceState[]): void {
        if (this.disposed) return;
        const RECENT_MS = 10 * 60 * 1000;   // 10 分钟内算"有会话"
        const now = Date.now();
        const recent = states.filter(ws => (now - ws.lastActiveMs) < RECENT_MS);

        if (recent.length === 0) {
            // 没有近期会话: 若窗已开, 写空让它显示"等待会话"; 不主动启动新窗
            if (this.process && this.lastSerialized !== '') {
                try {
                    fs.writeFileSync(this.stateFile, '', 'utf8');
                    this.lastSerialized = '';
                } catch { /* 忽略 */ }
            }
            return;
        }

        this.ensureWindow();
        // 序列化: 每行 "STATE|项目名"
        const lines = recent.map(ws => `${ws.state}|${ws.project}`);
        const serialized = lines.join('\n');
        if (serialized !== this.lastSerialized) {
            try {
                fs.writeFileSync(this.stateFile, serialized + '\n', 'utf8');
                this.lastSerialized = serialized;
            } catch { /* 忽略 */ }
        }
    }

    private ensureWindow(): void {
        if (this.process || this.disposed) return;
        if (!fs.existsSync(this.exePath)) {
            console.warn('[marquee] EXE 不存在:', this.exePath);
            return;
        }
        try {
            // 初始位置: 屏幕右上角附近(用固定值, 小窗会自动 TopMost)
            this.process = spawn(this.exePath, [this.stateFile, '60', '40'], {
                detached: false,
                windowsHide: false,
            });
            this.process.on('error', (err) => {
                console.warn('[marquee] 启动窗失败:', err.message);
                this.process = null;
            });
            this.process.on('exit', () => {
                this.process = null;
            });
        } catch (e) {
            console.warn('[marquee] spawn 异常:', e);
        }
    }

    dispose(): void {
        this.disposed = true;
        try { this.process?.kill(); } catch { /* 忽略 */ }
        this.process = null;
        try { if (fs.existsSync(this.stateFile)) fs.unlinkSync(this.stateFile); } catch { /* 忽略 */ }
    }
}
