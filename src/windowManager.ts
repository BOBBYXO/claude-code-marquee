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
    }

    // 收到所有工作区状态, 写共享汇总文件 + 确保窗已启动
    // 读-改-写模式: 保留其他扩展的会话, 只更新自己的
    update(states: WorkspaceState[]): void {
        if (this.disposed) return;
        const RECENT_MS = 10 * 60 * 1000;
        const now = Date.now();
        const recent = states.filter(ws => (now - ws.lastActiveMs) < RECENT_MS);

        // 读当前文件, 保留其他扩展的会话
        const allEntries = new Map<string, string>(); // project -> STATE
        try {
            const content = fs.readFileSync(this.stateFile, 'utf8');
            for (const line of content.split('\n')) {
                const ln = line.trim();
                if (!ln) continue;
                const parts = ln.split('|');
                if (parts.length >= 2) {
                    allEntries.set(parts[1].trim(), parts[0].trim());
                }
            }
        } catch { /* 文件不存在等, 正常 */ }

        if (recent.length > 0) {
            // 写入/更新自己的会话
            for (const ws of recent) {
                allEntries.set(ws.project, ws.state);
            }
        } else {
            // 没有会话: 不写, 保留其他扩展的会话(它们可能还在活跃)
            return;
        }

        // 序列化: 每行 "STATE|项目名", 排序保证稳定
        const lines = Array.from(allEntries.entries())
            .map(([proj, st]) => `${st}|${proj}`)
            .sort();
        const serialized = lines.join('\n');
        if (serialized !== this.lastSerialized) {
            try {
                fs.writeFileSync(this.stateFile, serialized + '\n', 'utf8');
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