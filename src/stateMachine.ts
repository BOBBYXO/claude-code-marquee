// 状态机: 从 Claude Code transcript 事件序列推断瞬时状态
// 依据本机真实 transcript 反推验证, 详见记忆 claude-code-transcript-format

export type ClaudeState =
    | 'IDLE'            // 空闲/无活跃会话
    | 'THINKING'        // 思考中
    | 'TOOL_RUNNING'    // 工具执行中
    | 'WAITING_INPUT'   // 等待用户输入
    | 'ERROR';          // 出错

// 从一行 JSONL 解析出的标准化事件
export interface TranscriptEvent {
    type: 'assistant' | 'user' | 'system' | 'last-prompt' | 'mode' | 'permission-mode' | 'attachment' | 'file-history-snapshot' | 'ai-title' | string;
    timestamp?: string;         // ISO 时间
    stopReason?: string | null; // assistant 行的 message.stop_reason
    blockTypes?: string[];      // message.content[].type 去重列表
    toolUseIds?: string[];      // assistant 行发起的 tool_use id
    toolResultIds?: string[];   // user 行返回的 tool_result 对应的 tool_use_id
    systemSubtype?: string;     // system 行的 subtype
}

// 活跃阈值: 最近这段时间内有新事件算"活跃", 超过算空闲
const ACTIVITY_WINDOW_MS = 8000;
// tool_use 超时: 发起后这么久没收到对应 result, 认为工具还在跑(继续显示 TOOL_RUNNING)
const TOOL_TIMEOUT_MS = 60000;

export interface StateContext {
    state: ClaudeState;
    detail?: string; // 附加信息, 如工具名、错误文本
}

/**
 * 根据已解析事件序列推断当前瞬时状态.
 * events 按时间正序. nowMs 为当前时间戳(可注入便于测试).
 */
export function inferState(events: TranscriptEvent[], nowMs: number = Date.now()): StateContext {
    if (events.length === 0) {
        return { state: 'IDLE' };
    }

    const last = events[events.length - 1];
    const lastTs = parseTs(last.timestamp);

    // 收集所有 tool_use id, 减去已收到 tool_result 的, 得到"未完成"的工具调用
    const pendingToolUses: string[] = [];
    const completedToolUses = new Set<string>();
    for (const e of events) {
        if (e.toolUseIds) {
            for (const id of e.toolUseIds) pendingToolUses.push(id);
        }
        if (e.toolResultIds) {
            for (const id of e.toolResultIds) completedToolUses.add(id);
        }
    }
    const unfinishedTools = pendingToolUses.filter(id => !completedToolUses.has(id));

    // 有未完成的 tool_use: 用 TOOL_TIMEOUT_MS(60s) 窗口, 让长时间运行的 bash/工具不误判为空闲
    if (unfinishedTools.length > 0) {
        if (lastTs != null && (nowMs - lastTs) <= TOOL_TIMEOUT_MS) {
            return { state: 'TOOL_RUNNING' };
        }
        // 超过 60s 没结果, 认为工具卡住/会话已死
        return { state: 'IDLE' };
    }

    // 空闲优先: 最近无新事件 -> IDLE
    const recent = lastTs != null && (nowMs - lastTs) <= ACTIVITY_WINDOW_MS;
    if (!recent) {
        return { state: 'IDLE' };
    }

    // 出错判定: 仅当最后一条事件就是 api_error 时才算出错.
    // (历史 api_error 后若已有其他事件, 说明会话已恢复, 不再亮红)
    if (last.type === 'system' && last.systemSubtype === 'api_error') {
        return { state: 'ERROR', detail: 'API 错误' };
    }

    // 按最后一条事件类型判定
    switch (last.type) {
        case 'assistant': {
            // 无未完成工具: 看 stop_reason
            if (last.stopReason === 'end_turn') {
                return { state: 'WAITING_INPUT' };
            }
            // 正在思考(streaming, stop_reason=None 或 tool_use 但工具未真正发起)
            if (recent) {
                return { state: 'THINKING' };
            }
            // 不活跃了, 视为空闲
            return { state: 'WAITING_INPUT' };
        }
        case 'user': {
            // user 行通常是 tool_result(工具刚返回) 或 用户主动输入
            // tool_result 回来后, Claude 即将开始新一轮思考
            if (last.toolResultIds && last.toolResultIds.length > 0) {
                return recent ? { state: 'THINKING' } : { state: 'IDLE' };
            }
            // 用户刚输入新指令 -> Claude 即将思考
            return recent ? { state: 'THINKING' } : { state: 'IDLE' };
        }
        case 'system': {
            if (last.systemSubtype === 'api_error' && recent) {
                return { state: 'ERROR' };
            }
            // 其他系统事件(turn_duration 等)不改变状态, 用前一条推断
            return inferState(events.slice(0, -1), nowMs);
        }
        default:
            // 元数据事件(last-prompt/mode 等), 递归看前一条
            if (events.length > 1) {
                return inferState(events.slice(0, -1), nowMs);
            }
            return { state: 'IDLE' };
    }
}

function parseTs(iso?: string): number | null {
    if (!iso) return null;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : t;
}

function findLast<T>(arr: T[], pred: (x: T) => boolean): T | undefined {
    for (let i = arr.length - 1; i >= 0; i--) {
        if (pred(arr[i])) return arr[i];
    }
    return undefined;
}

// 工具用: 超时常量
export const _TIMEOUTS = { ACTIVITY_WINDOW_MS, TOOL_TIMEOUT_MS };

// 状态优先级: 越忙越大. 用于合并同一工作区多个会话的状态(取最忙).
const STATE_PRIORITY: Record<ClaudeState, number> = {
    IDLE: 0,
    WAITING_INPUT: 1,
    THINKING: 2,
    TOOL_RUNNING: 3,
    ERROR: 4,
};

/**
 * 合并多个会话的状态, 取最忙的那个(优先级最高).
 * 用于: 同一工作区有多个 Claude 会话时, 该工作区的窗显示最忙会话的状态.
 */
export function mergeStates(contexts: StateContext[]): StateContext {
    if (contexts.length === 0) return { state: 'IDLE' };
    let best = contexts[0];
    let bestPri = STATE_PRIORITY[best.state] ?? 0;
    for (let i = 1; i < contexts.length; i++) {
        const pri = STATE_PRIORITY[contexts[i].state] ?? 0;
        if (pri > bestPri) {
            best = contexts[i];
            bestPri = pri;
        }
    }
    return best;
}
