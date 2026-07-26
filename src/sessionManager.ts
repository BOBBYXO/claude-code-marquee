import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter, Disposable } from 'vscode';
import { inferState, mergeStates, TranscriptEvent, StateContext, ClaudeState } from './stateMachine';
export type { ClaudeState };

// 路径比对: 忽略大小写和斜杠方向差异
function samePath(a: string, b: string): boolean {
    return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

// cwd -> 项目名(取最后一段目录名)
function projectOf(cwd: string): string {
    if (!cwd) return 'unknown';
    const norm = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
    const seg = norm.split('/').filter(Boolean).pop();
    return seg || cwd;
}

interface RawLine {
    type?: string;
    timestamp?: string;
    cwd?: string;
    subtype?: string;
    message?: {
        stop_reason?: string | null;
        content?: Array<{
            type?: string;
            id?: string;
            tool_use_id?: string;
            name?: string;
        }>;
    };
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

export interface WorkspaceState {
    cwd: string;
    project: string;
    state: ClaudeState;
    detail?: string;
    lastActiveMs: number;   // 该工作区最近会话文件的修改时间
}

export class SessionManager implements Disposable {
    private _onStates = new EventEmitter<WorkspaceState[]>();
    readonly onStates = this._onStates.event;

    private pollTimer: NodeJS.Timeout | undefined;
    private disposed = false;
    private readonly maxEvents = 300;

    start(): void {
        // 立即扫一次
        this.scan();
        // 轮询: 检测新会话/状态变化
        this.pollTimer = setInterval(() => this.scan(), 1500);
    }

    // 扫描所有会话, 按 cwd 分组, 合并状态, emit
    private scan(): void {
        const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
        // cwd(规范化) -> { cwd, files: [{full, mtime}] }
        const byCwd = new Map<string, { cwd: string; files: { full: string; mtime: number }[] }>();

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
                    try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
                    const cwd = this.readCwdFromTail(full);
                    if (!cwd) continue; // 无 cwd 的会话跳过
                    const key = cwd.replace(/\\/g, '/').toLowerCase();
                    if (!byCwd.has(key)) byCwd.set(key, { cwd, files: [] });
                    byCwd.get(key)!.files.push({ full, mtime });
                }
            }
        } catch {
            this._onStates.fire([]);
            return;
        }

        // 每个 cwd: 取最近若干个会话文件, 各算状态, 合并取最忙
        const result: WorkspaceState[] = [];
        for (const { cwd, files } of byCwd.values()) {
            // 按修改时间倒序, 只取最近 5 个会话(避免无限历史/过多计算)
            files.sort((a, b) => b.mtime - a.mtime);
            const recent = files.slice(0, 5);
            const ctxs: StateContext[] = [];
            for (const f of recent) {
                const events = this.readTailEvents(f.full, this.maxEvents);
                if (events.length === 0) continue;
                ctxs.push(inferState(events));
            }
            const merged = mergeStates(ctxs);
            // 该工作区最近活动时间 = 最新会话文件的 mtime
            const lastActiveMs = files.length > 0 ? files[0].mtime : 0;
            result.push({ cwd, project: projectOf(cwd), state: merged.state, detail: merged.detail, lastActiveMs });
        }

        this._onStates.fire(result);
    }

    // 读 jsonl 尾部 maxEvents 条事件
    private readTailEvents(file: string, maxEvents: number): TranscriptEvent[] {
        try {
            const buf = fs.readFileSync(file);
            const lines = buf.toString('utf8').split(/\r?\n/);
            const tail = lines.slice(-maxEvents);
            const events: TranscriptEvent[] = [];
            for (const ln of tail) {
                const ev = parseLine(ln);
                if (ev) events.push(ev);
            }
            return events;
        } catch {
            return [];
        }
    }

    // 从 jsonl 尾部倒着读几行, 提取 cwd
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

    dispose(): void {
        this.disposed = true;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
        this._onStates.dispose();
    }
}
