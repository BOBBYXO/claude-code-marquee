import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { EventEmitter, Disposable } from 'vscode';
import { inferState, TranscriptEvent, StateContext } from './stateMachine';

// 路径比对: 忽略大小写和斜杠方向差异(Windows 路径不区分大小写, \ 和 / 等价)
function samePath(a: string, b: string): boolean {
    return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

interface RawLine {
    uuid?: string;
    type?: string;
    timestamp?: string;
    cwd?: string;
    message?: {
        role?: string;
        stop_reason?: string | null;
        content?: Array<{
            type?: string;
            id?: string;          // tool_use 的 id
            tool_use_id?: string;  // tool_result 引用的 id
            name?: string;         // 工具名
        }>;
    };
    subtype?: string;
}

function parseLine(line: string): TranscriptEvent | null {
    if (!line.trim()) return null;
    let raw: RawLine;
    try {
        raw = JSON.parse(line);
    } catch {
        return null;
    }
    if (!raw.type) return null;

    const blockTypes = new Set<string>();
    const toolUseIds: string[] = [];
    const toolResultIds: string[] = [];
    let toolName: string | undefined;

    if (Array.isArray(raw.message?.content)) {
        for (const blk of raw.message!.content!) {
            if (blk?.type) blockTypes.add(blk.type);
            if (blk?.type === 'tool_use' && blk.id) {
                toolUseIds.push(blk.id);
                if (blk.name) toolName = blk.name;
            }
            if (blk?.type === 'tool_result' && blk.tool_use_id) {
                toolResultIds.push(blk.tool_use_id);
            }
        }
    }

    return {
        type: raw.type,
        timestamp: raw.timestamp,
        stopReason: raw.message?.stop_reason ?? undefined,
        blockTypes: blockTypes.size ? Array.from(blockTypes) : undefined,
        toolUseIds: toolUseIds.length ? toolUseIds : undefined,
        toolResultIds: toolResultIds.length ? toolResultIds : undefined,
        systemSubtype: raw.subtype,
        detail: toolName,
    } as TranscriptEvent & { detail?: string };
}

export class TranscriptWatcher implements Disposable {
    private _onState = new EventEmitter<StateContext & { detail?: string }>();
    readonly onState = this._onState.event;

    private fsWatcher: fs.FSWatcher | undefined;
    private currentFile: string | undefined;
    private events: TranscriptEvent[] = [];
    private processedBytes = 0;
    private pollTimer: NodeJS.Timeout | undefined;
    private disposed = false;

    constructor(private readonly maxEvents = 500) {}

    start(): void {
        this.locateAndWatch();
    }

    /** 重新定位活跃会话(工作区切换时调用) */
    retarget(): void {
        this.stopWatch();
        this.events = [];
        this.processedBytes = 0;
        this.locateAndWatch();
    }

    private locateAndWatch(): void {
        const file = this.findActiveSession();
        if (!file) {
            this.emitIdle('未找到 Claude Code 会话目录');
            return;
        }
        this.currentFile = file;
        // 先把现有内容读进来(从末尾留少量, 避免巨文件)
        this.readExisting(file);
        this.watchFile(file);
        this.emit();
    }

    // 遍历 ~/.claude/projects/*/*.jsonl, 读出每条记录的 cwd 字段与当前工作区比对.
    // 这样无需猜测 Claude Code 的路径编码规则(中文等也能正确匹配).
    // 返回: 优先返回属于当前工作区且最近修改的 jsonl; 都不匹配则回退到全局最近修改的 jsonl.
    private findActiveSession(): string | undefined {
        const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
        const targetCwd = vscode.workspace?.workspaceFolders?.[0]?.uri.fsPath;

        let allJsonls: { full: string; mtime: number; cwd?: string }[] = [];
        try {
            for (const dir of fs.readdirSync(projectsRoot)) {
                const dirFull = path.join(projectsRoot, dir);
                let isDir = false;
                try { isDir = fs.statSync(dirFull).isDirectory(); } catch { /* skip */ }
                if (!isDir) continue;
                for (const name of fs.readdirSync(dirFull)) {
                    if (!name.endsWith('.jsonl')) continue;
                    const full = path.join(dirFull, name);
                    let mtime = 0;
                    try { mtime = fs.statSync(full).mtimeMs; } catch { /* skip */ }
                    allJsonls.push({ full, mtime, cwd: undefined });
                }
            }
        } catch {
            return undefined;
        }
        if (allJsonls.length === 0) return undefined;

        allJsonls.sort((a, b) => b.mtime - a.mtime);

        // 无目标工作区: 直接返回最近修改的
        if (!targetCwd) return allJsonls[0].full;

        // 读每个文件的尾部, 提取 cwd, 找第一个匹配的
        for (const item of allJsonls) {
            const cwd = this.readCwdFromTail(item.full);
            if (cwd && samePath(cwd, targetCwd)) {
                return item.full;
            }
        }
        // 都不匹配: 回退到最近修改的(可能是工作区外/编码差异)
        return allJsonls[0].full;
    }

    // 从 jsonl 尾部倒着读几行, 提取第一个出现的 cwd 字段(避免读整个大文件)
    private readCwdFromTail(file: string): string | undefined {
        try {
            const stat = fs.statSync(file);
            const tailLen = Math.min(stat.size, 8192);
            const fd = fs.openSync(file, 'r');
            const buf = Buffer.alloc(tailLen);
            fs.readSync(fd, buf, 0, tailLen, Math.max(0, stat.size - tailLen));
            fs.closeSync(fd);
            const lines = buf.toString('utf8').split(/\r?\n/).filter(Boolean);
            for (let i = lines.length - 1; i >= 0; i--) {
                try {
                    const raw = JSON.parse(lines[i]) as RawLine;
                    if (raw.cwd) return raw.cwd;
                } catch { /* skip */ }
            }
        } catch { /* skip */ }
        return undefined;
    }

    private readExisting(file: string): void {
        try {
            const buf = fs.readFileSync(file);
            const text = buf.toString('utf8');
            this.processedBytes = buf.length;
            const lines = text.split(/\r?\n/);
            // 只保留最后 maxEvents 条, 避免内存/计算浪费
            const tail = lines.slice(-this.maxEvents);
            for (const ln of tail) {
                const ev = parseLine(ln);
                if (ev) this.events.push(ev);
            }
        } catch {
            // 读取失败忽略, 后续 watcher 会继续尝试
        }
    }

    private watchFile(file: string): void {
        // Node fs.watch 在 Windows 上对追加写入触发 change 事件
        try {
            this.fsWatcher = fs.watch(file, (eventType) => {
                if (eventType === 'change' || eventType === 'rename') {
                    this.readIncremental(file);
                }
            });
        } catch {
            // 某些环境 fs.watch 不可用, 降级为轮询
        }
        // 轮询兜底: 弥补 fs.watch 在部分场景不触发, 以及判定活跃/空闲
        this.pollTimer = setInterval(() => {
            this.readIncremental(file);
            // 重新检测: 当前文件可能不再是最新的(新会话开始)
            this.maybeRetargetToNewer();
        }, 1500);
    }

    private readIncremental(file: string): void {
        try {
            const stat = fs.statSync(file);
            if (stat.size < this.processedBytes) {
                // 文件被截断/轮转, 重新读
                this.events = [];
                this.processedBytes = 0;
                this.readExisting(file);
                this.emit();
                return;
            }
            if (stat.size === this.processedBytes) {
                // 无新增, 但可能需要根据"是否还活跃"重算状态
                this.emit();
                return;
            }
            const fd = fs.openSync(file, 'r');
            const length = stat.size - this.processedBytes;
            const buf = Buffer.alloc(length);
            fs.readSync(fd, buf, 0, length, this.processedBytes);
            fs.closeSync(fd);
            this.processedBytes = stat.size;
            const newLines = buf.toString('utf8').split(/\r?\n/);
            for (const ln of newLines) {
                const ev = parseLine(ln);
                if (ev) {
                    this.events.push(ev);
                    // 限制内存
                    if (this.events.length > this.maxEvents) {
                        this.events = this.events.slice(-this.maxEvents);
                    }
                }
            }
            this.emit();
        } catch {
            // 文件可能正被写入, 忽略本次
        }
    }

    private maybeRetargetToNewer(): void {
        if (!this.currentFile) return;
        // 重新查找当前工作区的活跃会话; 若切到了更新的文件则切换
        const latest = this.findActiveSession();
        if (latest && latest !== this.currentFile) {
            // 仅当目标比当前文件更新时才切(避免误切到旧文件)
            try {
                const cur = fs.statSync(this.currentFile).mtimeMs;
                const nxt = fs.statSync(latest).mtimeMs;
                if (nxt <= cur) return;
            } catch { return; }
            this.stopWatch();
            this.events = [];
            this.processedBytes = 0;
            this.currentFile = latest;
            this.readExisting(latest);
            this.watchFile(latest);
            this.emit();
        }
    }

    private emit(): void {
        const ctx = inferState(this.events);
        // 附加最近工具名作为 detail
        const lastTool = [...this.events].reverse().find(e => e.toolUseIds && e.toolUseIds.length);
        this._onState.fire({
            ...ctx,
            detail: ctx.detail || (lastTool as any)?.detail,
        });
    }

    private emitIdle(reason: string): void {
        this._onState.fire({ state: 'IDLE', detail: reason });
    }

    private stopWatch(): void {
        this.fsWatcher?.close();
        this.fsWatcher = undefined;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
    }

    dispose(): void {
        this.disposed = true;
        this.stopWatch();
        this._onState.dispose();
    }
}
