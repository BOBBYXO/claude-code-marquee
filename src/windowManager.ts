import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { ChildProcess, spawn } from 'child_process';
import { Disposable, ExtensionContext } from 'vscode';
import { WorkspaceState } from './sessionManager';

// 单窗多会话: 所有扩展实例共享一个 state 文件 + 一个 EXE 进程
// 多个 VS Code 窗口不再重复启动跑马灯
export class WindowManager implements Disposable {
    private process: ChildProcess | null = null;
    private disposed = false;
    private readonly exePath: string;
    private readonly stateFile: string;
    private lastSerialized = '';
    private spawnFailed = false;

    constructor(context: ExtensionContext) {
        this.exePath = path.join(context.asAbsolutePath('.'), 'window', 'MarqueeWindow.exe');
        // 共享 state 文件: 所有扩展实例都写 %TEMP%/claude-marquee-state.txt
        this.stateFile = path.join(tmpdir(), 'claude-marquee-state.txt');
        // 立即 spawn 窗口显示"等待会话", 不等首次 scan 完成(解决启动慢)
        this.ensureWindow();
    }

    // 收到所有工作区状态, 全量写入共享汇总文件 + 确保窗已启动
    update(states: WorkspaceState[]): void {
        if (this.disposed) return;
        const RECENT_MS = 10 * 60 * 1000;
        const now = Date.now();
        const recent = states.filter(ws => (now - ws.lastActiveMs) < RECENT_MS);

        // 全量覆盖: 本次 scan 的 recent 会话即为当前应显示的全部.
        // 不再读-改-写保留旧条目(那会让已关闭/过期的会话永久残留).
        // 多个 VS Code 窗口的扩展实例 scan 同一份 ~/.claude/projects, 数据一致, 无需互相保留.
        const lines = recent
            .map(ws => `${ws.state}|${ws.project}`)
            .sort();
        const serialized = lines.join('\n');
        if (serialized !== this.lastSerialized) {
            try {
                // 有会话写全量, 无会话清空(跑马灯回归"等待会话")
                fs.writeFileSync(this.stateFile, serialized ? serialized + '\n' : '', 'utf8');
                this.lastSerialized = serialized;
            } catch { /* 忽略 */ }
        }

        this.ensureWindow();
    }

    private ensureWindow(): void {
        if (this.process || this.disposed || this.spawnFailed) return;
        if (!fs.existsSync(this.exePath)) {
            console.warn('[marquee] EXE 不存在:', this.exePath);
            return;
        }
        try {
            this.process = spawn(this.exePath, [this.stateFile, '60', '40'], {
                detached: false,
                windowsHide: false,
            });
            this.process.on('error', (err) => {
                console.warn('[marquee] 启动窗失败:', err.message);
                this.process = null;
                this.spawnFailed = true;
            });
            this.process.on('exit', (code) => {
                this.process = null;
                if (code === 0) this.spawnFailed = true; // 0 = 已有实例退出
            });
        } catch (e) {
            console.warn('[marquee] spawn 异常:', e);
            this.spawnFailed = true;
        }
    }

    dispose(): void {
        this.disposed = true;
        // 不杀 EXE 进程, 不删 state 文件(其他扩展可能还在用)
        this.process = null;
    }
}