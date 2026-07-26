import * as vscode from 'vscode';
import { SessionManager } from './sessionManager';
import { WindowManager } from './windowManager';

let sessionManager: SessionManager | undefined;
let windowManager: WindowManager | undefined;

export function activate(context: vscode.ExtensionContext) {
    // VS Code 启动后自动启动跑马灯(onStartupFinished 激活)
    startMarquee(context);

    // 保留手动命令: 显式启动/重启
    const openCmd = vscode.commands.registerCommand('claudeCodeMarquee.open', () => {
        startMarquee(context);
        vscode.window.showInformationMessage('Claude Code 跑马灯已启动');
    });

    context.subscriptions.push(openCmd);
}

function startMarquee(context: vscode.ExtensionContext) {
    if (sessionManager) return;  // 已在运行
    windowManager = new WindowManager(context);
    sessionManager = new SessionManager();
    sessionManager.onStates((states) => {
        windowManager?.update(states);
    });
    sessionManager.start();
}

export function deactivate() {
    sessionManager?.dispose();
    sessionManager = undefined;
    windowManager?.dispose();
    windowManager = undefined;
}
