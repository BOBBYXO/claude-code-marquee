import * as fs from 'fs';
import { promises as fsp } from 'fs';
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

// 文件级缓存: mtime/size 未变则复用 cwd 和 events, 跳过所有文件读取
interface FileCache {
    mtime: number;
    size: number;
    cwd?: string;
    events: TranscriptEvent[];
}

// 尾部读取量: 1MB 通常足够覆盖最近数百条事件(含 base64 行), 远小于读整个 17MB 文件
const TAIL_BYTES = 1024 * 1024;
const CWD_TAIL_BYTES = 8192;
// 事件去抖窗口: watch 短时间多次 change 合并为一次 scan
const DEBOUNCE_MS = 300;
// 轮询兜底间隔: 仅捕获 watch 漏报(网络盘/某些环境)
const POLL_INTERVAL_MS = 5000;

export class SessionManager implements Disposable {
    private _onStates = new EventEmitter<WorkspaceState[]>();
    readonly onStates = this._onStates.event;

    private pollTimer: NodeJS.Timeout | undefined;
    private watcher: fs.FSWatcher | undefined;
    private scanTimer: NodeJS.Timeout | undefined;
    private disposed = false;
    private readonly maxEvents = 300;
    private readonly projectsRoot = path.join(os.homedir(), '.claude', 'projects');
    private cache = new Map<string, FileCache>();
    private scanning = false;
    private pendingScan = false;

    start(): void {
        // 立即异步扫一次(不阻塞 activate)
        this.scheduleScan();
        // 事件驱动: 文件变化时重扫(仅重读变化文件)
        this.startWatch();
        // 低频兜底: 捕获 watch 漏报
        this.pollTimer = setInterval(() => this.scheduleScan(), POLL_INTERVAL_MS);
    }

    private startWatch(): void {
        try {
            // Windows 支持 recursive, 监听整个 projects 目录树
            this.watcher = fs.watch(this.projectsRoot, { recursive: true }, () => {
                this.scheduleScan();
            });
            this.watcher.on('error', () => { /* watch 失败, 轮询兜底 */ });
        } catch {
            // 不可用, 仅靠轮询
        }
    }

    // 去抖: 短时间多次触发合并为一次 scan
    private scheduleScan(): void {
        if (this.disposed) return;
        if (this.scanTimer) return;
        this.scanTimer = setTimeout(() => {
            this.scanTimer = undefined;
            this.scan();
        }, DEBOUNCE_MS);
    }

    // 扫描所有会话, 按 cwd 分组, 合并状态, emit
    private async scan(): Promise<void> {
        if (this.scanning || this.disposed) {
            if (!this.disposed) this.pendingScan = true;
            return;
        }
        this.scanning = true;
        try {
            const byCwd = new Map<string, { cwd: string; files: { full: string; mtime: number }[] }>();

            let dirs: string[];
            try {
                dirs = await fsp.readdir(this.projectsRoot);
            } catch {
                this._onStates.fire([]);
                return;
            }

            // 收集所有 jsonl + stat(全异步, 不阻塞扩展宿主)
            const allFiles: { full: string; stat: fs.Stats }[] = [];
            for (const dir of dirs) {
                const dirFull = path.join(this.projectsRoot, dir);
                let isDir = false;
                try { isDir = (await fsp.stat(dirFull)).isDirectory(); } catch { continue; }
                if (!isDir) continue;
                let names: string[];
                try { names = await fsp.readdir(dirFull); } catch { continue; }
                for (const name of names) {
                    if (!name.endsWith('.jsonl')) continue;
                    const full = path.join(dirFull, name);
                    try {
                        const stat = await fsp.stat(full);
                        allFiles.push({ full, stat });
                    } catch { continue; }
                }
            }

            // 清理已删除文件的缓存
            const currentFiles = new Set(allFiles.map(f => f.full));
            for (const key of this.cache.keys()) {
                if (!currentFiles.has(key)) this.cache.delete(key);
            }

            // 每个文件: 比对 mtime/size, 未变复用缓存, 变了才重读
            for (const { full, stat } of allFiles) {
                const cached = this.cache.get(full);
                if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
                    if (cached.cwd) this.addToCwdMap(byCwd, cached.cwd, full, stat.mtimeMs);
                    continue;
                }
                const cwd = await this.readCwdFromTail(full, stat);
                const events = await this.readTailEvents(full, stat);
                this.cache.set(full, { mtime: stat.mtimeMs, size: stat.size, cwd, events });
                if (cwd) this.addToCwdMap(byCwd, cwd, full, stat.mtimeMs);
            }

            // 每个 cwd: 取最近若干个会话文件, 合并状态取最忙
            const result: WorkspaceState[] = [];
            for (const { cwd, files } of byCwd.values()) {
                files.sort((a, b) => b.mtime - a.mtime);
                const recent = files.slice(0, 5);
                const ctxs: StateContext[] = [];
                for (const f of recent) {
                    const ev = this.cache.get(f.full)?.events ?? [];
                    if (ev.length === 0) continue;
                    ctxs.push(inferState(ev));
                }
                const merged = mergeStates(ctxs);
                const lastActiveMs = files.length > 0 ? files[0].mtime : 0;
                result.push({ cwd, project: projectOf(cwd), state: merged.state, detail: merged.detail, lastActiveMs });
            }

            this._onStates.fire(result);
        } finally {
            this.scanning = false;
            if (this.pendingScan && !this.disposed) {
                this.pendingScan = false;
                this.scheduleScan();
            }
        }
    }

    private addToCwdMap(byCwd: Map<string, { cwd: string; files: { full: string; mtime: number }[] }>, cwd: string, full: string, mtime: number): void {
        const key = cwd.replace(/\\/g, '/').toLowerCase();
        if (!byCwd.has(key)) byCwd.set(key, { cwd, files: [] });
        byCwd.get(key)!.files.push({ full, mtime });
    }

    // 从文件尾部反向读 TAIL_BYTES, 解析行, 取尾部 maxEvents 条事件(正序)
    // 不再 readFileSync 整个大文件(含图片 base64 可达 17MB+)
    private async readTailEvents(file: string, stat: fs.Stats): Promise<TranscriptEvent[]> {
        try {
            const len = Math.min(stat.size, TAIL_BYTES);
            const buf = Buffer.alloc(len);
            const fh = await fsp.open(file, 'r');
            await fh.read(buf, 0, len, Math.max(0, stat.size - len));
            await fh.close();
            const lines = buf.toString('utf8').split(/\r?\n/);
            // 若从中间读(文件 > TAIL_BYTES), 第一行被截断, 丢弃
            const start = stat.size > TAIL_BYTES ? 1 : 0;
            const events: TranscriptEvent[] = [];
            for (let i = lines.length - 1; i >= start && events.length < this.maxEvents; i--) {
                const ev = parseLine(lines[i]);
                if (ev) events.unshift(ev);
            }
            return events;
        } catch {
            return [];
        }
    }

    // 从 jsonl 尾部读 CWD_TAIL_BYTES, 倒着找第一个 cwd 字段(复用传入 stat, 不重复 statSync)
    private async readCwdFromTail(file: string, stat: fs.Stats): Promise<string | undefined> {
        try {
            const len = Math.min(stat.size, CWD_TAIL_BYTES);
            const buf = Buffer.alloc(len);
            const fh = await fsp.open(file, 'r');
            await fh.read(buf, 0, len, Math.max(0, stat.size - len));
            await fh.close();
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
        if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
        if (this.scanTimer) { clearTimeout(this.scanTimer); this.scanTimer = undefined; }
        this.watcher?.close();
        this.watcher = undefined;
        this._onStates.dispose();
    }
}
