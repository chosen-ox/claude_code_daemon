// GUI HTTP Server - Provides web-based interface for cc-daemon

import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import WebSocket, { WebSocketServer } from 'ws';
import { taskManager } from '../task/manager.js';
import { listCcDaemonSessions, isTmuxAvailable, tmuxSessionExists, killTmuxSession, captureTmuxPane, captureTmuxPaneVisible, resizeTmuxWindow } from '../session/tmux-spawner.js';
import { TmuxRalphExecutor, type RalphProgressEvent } from '../session/tmux-ralph-executor.js';
import { RalphExecutor, type ProgressEvent } from '../session/ralph-executor.js';
import { isClaudeAvailable } from '../session/spawner.js';
import { findAllActiveSessions, formatTokenUsage, formatCost, createStatusDisplay } from '../session/fr4-monitor.js';
import { parseSessionFile } from '../session/monitor.js';
import { getModelContextLimit } from '../types/index.js';
import { getTaskDir, getPlanPath, getProgressPath, getMetadataPath, getTasksDir } from '../utils/paths.js';
import { verifyTask } from '../session/verification-executor.js';
import { startAutoTriggerMonitoring, stopAutoTriggerMonitoring, getAutoTriggerMonitor } from '../session/auto-trigger-monitor.js';
import type { TaskMetadata, TaskPlan, TaskProgress, TokenUsage, TaskStatus } from '../types/index.js';

export interface GuiOptions {
  port?: number;
  host?: string;
}

export interface TaskDetail {
  metadata: TaskMetadata;
  plan: TaskPlan;
  progress: TaskProgress;
  taskDir: string;
  tmuxSession?: string;
  tmuxAttachedCommand?: string;
  contextPercent?: number;
}

export interface TmuxSessionInfo {
  name: string;
  exists: boolean;
  attachCommand: string;
  claudeSessionId?: string;
  claudePrompt?: string;
  contextPercent?: number;
}

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Store active terminal WebSocket connections
const terminalConnections = new Map<string, Set<WebSocket>>();

/**
 * Get all tasks with detailed information
 */
export async function getTasksWithDetails(): Promise<TaskDetail[]> {
  const tasks = await taskManager.listTasks();
  const details: TaskDetail[] = [];

  for (const metadata of tasks) {
    try {
      const taskData = await taskManager.getTask(metadata.id);
      if (!taskData) continue;

      const taskDir = getTaskDir(metadata.id);

      // Find tmux session for this task
      const tmuxSessions = await listCcDaemonSessions();
      const taskSessionPrefix = `cc-daemon-${metadata.id.slice(0, 8)}`;
      const tmuxSession = tmuxSessions.find(s => s.startsWith(taskSessionPrefix));

      // Get context usage if there's an active session matching this task
      let contextPercent: number | undefined;
      const activeSessions = findAllActiveSessions();

      // Calculate expected project directory name from task directory
      const taskProjectDir = taskDir.replace(/^\//, '').replace(/\//g, '-');

      // Find the session that matches this task's project directory
      const matchingSession = activeSessions.find(s => s.jsonlPath.includes(`/${taskProjectDir}/`));

      if (matchingSession) {
        const { currentContextUsage } = await parseSessionFile(matchingSession.jsonlPath);
        const contextLimit = getModelContextLimit('default');
        const currentContext = currentContextUsage.inputTokens + currentContextUsage.cacheReadInputTokens;
        contextPercent = (currentContext / contextLimit * 100);
      }

      // Merge status from progress.md and metadata.json
      let effectiveStatus = taskData.metadata.status;
      const progressStatus = taskData.progress.currentStatus;
      const metaStatus = taskData.metadata.status;

      if (progressStatus === 'completed' || progressStatus === 'failed') {
        effectiveStatus = progressStatus;
        if (metaStatus !== progressStatus) {
          await taskManager.updateMetadata(metadata.id, { status: progressStatus });
        }
      } else {
        effectiveStatus = metaStatus;
        if (progressStatus !== metaStatus) {
          await taskManager.updateProgress(metadata.id, (progress) => {
            progress.currentStatus = metaStatus as TaskStatus;
            return progress;
          });
        }
      }

      const effectiveMetadata = { ...taskData.metadata, status: effectiveStatus };

      details.push({
        metadata: effectiveMetadata,
        plan: taskData.plan,
        progress: taskData.progress,
        taskDir,
        tmuxSession,
        tmuxAttachedCommand: tmuxSession ? `tmux -L cc-daemon attach -t ${tmuxSession}` : undefined,
        contextPercent
      });
    } catch (error) {
      console.error(`Error getting task ${metadata.id}:`, error);
    }
  }

  return details;
}

/**
 * Get tmux sessions info with associated Claude session data
 */
export async function getTmuxSessionsInfo(): Promise<TmuxSessionInfo[]> {
  if (!(await isTmuxAvailable())) {
    return [];
  }

  const sessions = await listCcDaemonSessions();
  const infos: TmuxSessionInfo[] = [];
  const contextLimit = getModelContextLimit('default');

  // Get all active sessions to find associations
  const activeSessions = findAllActiveSessions();

  for (const name of sessions) {
    const exists = await tmuxSessionExists(name);

    const taskIdMatch = name.match(/cc-daemon-task-([a-f0-9]{3})-\d+/);
    let claudeSessionId: string | undefined;
    let claudePrompt: string | undefined;
    let contextPercent: number | undefined;

    if (taskIdMatch) {
      const taskIdPrefix = taskIdMatch[1];

      const tasks = await taskManager.listTasks();
      const matchingTask = tasks.find(t => t.id.includes(taskIdPrefix));

      if (matchingTask) {
        const taskData = await taskManager.getTask(matchingTask.id);
        const currentSessionId = taskData?.progress.currentSessionId;

        if (currentSessionId) {
          const matchingSession = activeSessions.find(s => s.sessionId === currentSessionId);

          if (matchingSession) {
            claudeSessionId = matchingSession.sessionId;

            try {
              const { currentContextUsage, messages } = await parseSessionFile(matchingSession.jsonlPath);
              const currentContext = currentContextUsage.inputTokens + currentContextUsage.cacheReadInputTokens;
              contextPercent = (currentContext / contextLimit * 100);

              for (const msg of messages) {
                if ((msg as any).isMeta) continue;

                if (msg.role === 'user' || msg.type === 'user') {
                  let content = '';
                  const msgContent = msg.content || msg.message?.content;

                  if (typeof msgContent === 'string') {
                    content = msgContent;
                  } else if (Array.isArray(msgContent)) {
                    for (const item of msgContent) {
                      if (item.type === 'text' && item.text) {
                        content = item.text;
                        break;
                      }
                    }
                  }
                  if (content) {
                    const commandArgsMatch = content.match(/<command-args>([\s\S]*?)<\/command-args>/);
                    if (commandArgsMatch) {
                      claudePrompt = commandArgsMatch[1].trim();
                    } else {
                      claudePrompt = content.split('\n')[0];
                    }
                    if (claudePrompt && claudePrompt.length > 50) {
                      claudePrompt = claudePrompt.slice(0, 50) + '...';
                    }
                    break;
                  }
                }
              }
            } catch {
              // Ignore parse errors
            }
          }
        }
      }
    }

    infos.push({
      name,
      exists,
      attachCommand: `tmux -L cc-daemon attach -t ${name}`,
      claudeSessionId,
      claudePrompt,
      contextPercent
    });
  }

  return infos;
}

/**
 * Get active Claude sessions with context info
 */
export async function getActiveSessionsInfo(): Promise<Array<{
  sessionId: string;
  jsonlPath: string;
  modifiedAt: Date;
  tokens: TokenUsage;
  contextPercent: number;
  contextUsed: number;
  contextLimit: number;
  workingDir: string | null;
  firstPrompt: string | null;
  fullPrompt: string | null;
  tmuxSessionName: string | null;
  tmuxAttachCommand: string | null;
  isCcDaemonWorkSession: boolean;
  taskId?: string;
  taskGoal?: string;
}>> {
  const activeSessions = findAllActiveSessions();
  const contextLimit = getModelContextLimit('default');
  const tmuxSessions = await listCcDaemonSessions();

  // Collect all cc-daemon work session IDs from task history
  const allTasks = await taskManager.listTasks();
  const ccDaemonWorkSessionIds = new Map<string, { taskId: string; taskGoal: string }>();

  for (const task of allTasks) {
    const taskData = await taskManager.getTask(task.id);
    if (taskData) {
      // Add current session if exists
      if (taskData.progress.currentSessionId) {
        ccDaemonWorkSessionIds.set(taskData.progress.currentSessionId, {
          taskId: task.id,
          taskGoal: taskData.plan.goal
        });
      }
      // Add all historical sessions
      for (const sessionRecord of taskData.progress.sessionHistory) {
        ccDaemonWorkSessionIds.set(sessionRecord.sessionId, {
          taskId: task.id,
          taskGoal: taskData.plan.goal
        });
      }
    }
  }

  const infos = await Promise.all(activeSessions.map(async (session) => {
    const { currentContextUsage, messages, workingDir: parsedWorkingDir } = await parseSessionFile(session.jsonlPath);
    const currentContext = currentContextUsage.inputTokens + currentContextUsage.cacheReadInputTokens;
    const workingDir = parsedWorkingDir;

    let firstPrompt: string | null = null;
    let fullPrompt: string | null = null;
    for (const msg of messages) {
      if ((msg as any).isMeta) continue;

      if (msg.role === 'user' || msg.type === 'user') {
        let content = '';
        const msgContent = msg.content || msg.message?.content;

        if (typeof msgContent === 'string') {
          content = msgContent;
        } else if (Array.isArray(msgContent)) {
          for (const item of msgContent) {
            if (item.type === 'text' && item.text) {
              content = item.text;
              break;
            }
          }
        }
        if (content) {
          const commandArgsMatch = content.match(/<command-args>([\s\S]*?)<\/command-args>/);
          if (commandArgsMatch) {
            const commandArgs = commandArgsMatch[1].trim();
            fullPrompt = commandArgs;
            firstPrompt = commandArgs.length > 100 ? commandArgs.slice(0, 100) + '...' : commandArgs;
          } else {
            fullPrompt = content;
            // Check for special session types first
            if (content.includes('TASK VERIFICATION')) {
              firstPrompt = '🔍 TASK VERIFICATION - Clean Session';
            } else if (content.includes('FIX SESSION')) {
              firstPrompt = '🔧 FIX SESSION - Verification Failed';
            } else {
              // Try to get the first meaningful line
              const lines = content.trim().split('\n');
              for (const line of lines) {
                const trimmedLine = line.trim();
                if (trimmedLine && !trimmedLine.startsWith('═') && !trimmedLine.startsWith('---')) {
                  firstPrompt = trimmedLine.length > 100 ? trimmedLine.slice(0, 100) + '...' : trimmedLine;
                  break;
                }
              }
              // If no meaningful line found, use default
              if (!firstPrompt) {
                firstPrompt = 'Claude Session';
              }
            }
          }
          break;
        }
      }
    }

    let tmuxSessionName: string | null = null;
    let tmuxAttachCommand: string | null = null;

    // Check if this is a cc-daemon work session
    const workSessionInfo = ccDaemonWorkSessionIds.get(session.sessionId);
    const isCcDaemonWorkSession = workSessionInfo !== undefined;

    // Find tmux binding if this is a cc-daemon work session
    if (isCcDaemonWorkSession && workSessionInfo) {
      const taskIdPrefix = workSessionInfo.taskId.split('-')[1]?.slice(0, 3);
      if (taskIdPrefix) {
        for (const tmuxName of tmuxSessions) {
          if (tmuxName.includes(`-${taskIdPrefix}-`)) {
            tmuxSessionName = tmuxName;
            tmuxAttachCommand = `tmux -L cc-daemon attach -t ${tmuxName}`;
            break;
          }
        }
      }
    }

    return {
      sessionId: session.sessionId,
      jsonlPath: session.jsonlPath,
      modifiedAt: session.modifiedAt,
      tokens: currentContextUsage,
      contextPercent: (currentContext / contextLimit * 100),
      contextUsed: currentContext,
      contextLimit,
      workingDir,
      firstPrompt,
      fullPrompt,
      tmuxSessionName,
      tmuxAttachCommand,
      isCcDaemonWorkSession,
      taskId: workSessionInfo?.taskId,
      taskGoal: workSessionInfo?.taskGoal
    };
  }));

  return infos;
}

/**
 * Get dashboard statistics
 */
export async function getStats(): Promise<{
  total: number;
  active: number;
  pending: number;
  completed: number;
  failed: number;
  cancelled: number;
  totalTokens: number;
  totalCost: number;
  activeClaudeSessions: number;
}> {
  const allTasks = await taskManager.listTasks();
  const activeSessions = findAllActiveSessions();

  return {
    total: allTasks.length,
    active: allTasks.filter(t => t.status === 'active').length,
    pending: allTasks.filter(t => t.status === 'pending').length,
    completed: allTasks.filter(t => t.status === 'completed').length,
    failed: allTasks.filter(t => t.status === 'failed').length,
    cancelled: allTasks.filter(t => t.status === 'cancelled').length,
    totalTokens: allTasks.reduce((sum, t) => sum + (t.totalTokens || 0), 0),
    totalCost: allTasks.reduce((sum, t) => sum + (t.totalCost || 0), 0),
    activeClaudeSessions: activeSessions.length
  };
}

/**
 * Resolve workingDir to absolute path and ensure it exists
 */
function resolveWorkingDir(workingDir: string | undefined): string {
  const resolved = workingDir
    ? path.resolve(process.cwd(), workingDir)
    : process.cwd();
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

/**
 * Parse JSON body from request
 */
function parseJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Send JSON response
 */
function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Create HTTP server for GUI
 */
export function createGuiServer(options: GuiOptions = {}): http.Server {
  const port = options.port || 9876;
  const host = options.host || 'localhost';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${host}:${port}`);
    const method = req.method || 'GET';

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // ========== API Routes ==========

      // GET /api/tasks - List all tasks
      if (url.pathname === '/api/tasks' && method === 'GET') {
        const tasks = await getTasksWithDetails();
        sendJson(res, 200, tasks);
        return;
      }

      // POST /api/tasks - Create a new task and optionally start it
      if (url.pathname === '/api/tasks' && method === 'POST') {
        const body = await parseJsonBody<{
          goal: string;
          completionPromise?: string;
          maxIterations?: number;
          thresholdPercent?: number;
          steps?: string[];
          criteria?: string[];
          tmux?: boolean;
          ralphLoop?: boolean;
          enableVerification?: boolean;
          enableAutoTrigger?: boolean;
          dependsOn?: string[];
          tags?: string[];
          workingDir?: string;
        }>(req);

        if (!body.goal) {
          sendJson(res, 400, { error: 'Goal is required' });
          return;
        }

        // Check Claude availability
        if (!(await isClaudeAvailable())) {
          sendJson(res, 400, { error: 'Claude CLI is not available. Please install it first.' });
          return;
        }

        // Check tmux if requested
        const useTmux = body.tmux !== false;
        if (useTmux && !(await isTmuxAvailable())) {
          sendJson(res, 400, { error: 'tmux is not available. Install tmux or disable tmux option.' });
          return;
        }

        const completionPromise = body.completionPromise || 'TASK_COMPLETE';

        const metadata = await taskManager.createTask(body.goal, {
          completionPromise,
          maxIterations: body.maxIterations || 100,
          thresholdPercent: body.thresholdPercent || 80,
          steps: body.steps,
          acceptanceCriteria: body.criteria,
          dependsOn: body.dependsOn,
          tags: body.tags
        });

        // Start Ralph Loop in background with tmux
        const executor = new TmuxRalphExecutor({
          completionPromise,
          maxIterations: body.maxIterations || 100,
          thresholdPercent: body.thresholdPercent || 80,
          verbose: false,
          workingDir: resolveWorkingDir(body.workingDir),
          ralphLoopMode: body.ralphLoop || false,
          enableVerification: body.enableVerification || false,
          onProgress: (_event: RalphProgressEvent) => {
            // Progress events are handled internally
          }
        });

        executor.start(metadata.id).catch((err: unknown) => {
          console.error(`[GUI] Ralph Loop error for task ${metadata.id}:`, err);
        });

        // Start auto-trigger monitoring if requested
        if (body.enableAutoTrigger) {
          const monitor = getAutoTriggerMonitor();
          if (!monitor || !monitor.isRunning()) {
            startAutoTriggerMonitoring({
              pollInterval: 60000, // 1 minute default
              onStatusChange: (sessionName, status) => {
                console.log(`[AutoTrigger] ${sessionName}: ${status.status} - ${status.reason}`);
              },
              onTrigger: (sessionName, trigger) => {
                console.log(`[AutoTrigger] Sent trigger to ${sessionName}: ${trigger}`);
              }
            });
            console.log('[GUI] Auto-trigger monitoring started');
          }
        }

        sendJson(res, 201, {
          success: true,
          taskId: metadata.id,
          metadata,
          message: `Task created and started in tmux`
        });
        return;
      }

      // GET /api/tasks/:taskId - Get single task
      const taskMatch = url.pathname.match(/^\/api\/tasks\/([^\/]+)$/);
      if (taskMatch && method === 'GET') {
        const taskId = taskMatch[1];
        const task = await taskManager.getTask(taskId);
        if (!task) {
          sendJson(res, 404, { error: 'Task not found' });
          return;
        }

        const taskDir = getTaskDir(taskId);
        const tmuxSessions = await listCcDaemonSessions();
        const taskSessionPrefix = `cc-daemon-${taskId.slice(0, 8)}`;
        const tmuxSession = tmuxSessions.find(s => s.startsWith(taskSessionPrefix));

        let contextPercent: number | undefined;
        const activeSessions = findAllActiveSessions();

        const taskProjectDir = taskDir.replace(/^\//, '').replace(/\//g, '-');
        const matchingSession = activeSessions.find(s => s.jsonlPath.includes(`/${taskProjectDir}/`));

        if (matchingSession) {
          const { currentContextUsage } = await parseSessionFile(matchingSession.jsonlPath);
          const contextLimit = getModelContextLimit('default');
          const currentContext = currentContextUsage.inputTokens + currentContextUsage.cacheReadInputTokens;
          contextPercent = (currentContext / contextLimit * 100);
        }

        sendJson(res, 200, {
          metadata: task.metadata,
          plan: task.plan,
          progress: task.progress,
          taskDir,
          tmuxSession,
          tmuxAttachedCommand: tmuxSession ? `tmux -L cc-daemon attach -t ${tmuxSession}` : undefined,
          contextPercent
        });
        return;
      }

      // POST /api/tasks/:taskId/resume - Resume a task
      const resumeMatch = url.pathname.match(/^\/api\/tasks\/([^\/]+)\/resume$/);
      if (resumeMatch && method === 'POST') {
        const taskId = resumeMatch[1];
        const task = await taskManager.getTask(taskId);
        if (!task) {
          sendJson(res, 404, { error: 'Task not found' });
          return;
        }

        if (task.metadata.status !== 'failed' && task.metadata.status !== 'cancelled') {
          sendJson(res, 400, { error: `Cannot resume task with status: ${task.metadata.status}` });
          return;
        }

        await taskManager.updateMetadata(taskId, { status: 'active' });
        sendJson(res, 200, { success: true, message: 'Task resumed' });
        return;
      }

      // POST /api/tasks/:taskId/cancel - Cancel a task
      const cancelMatch = url.pathname.match(/^\/api\/tasks\/([^\/]+)\/cancel$/);
      if (cancelMatch && method === 'POST') {
        const taskId = cancelMatch[1];
        const task = await taskManager.getTask(taskId);
        if (!task) {
          sendJson(res, 404, { error: 'Task not found' });
          return;
        }

        if (task.metadata.status !== 'active' && task.metadata.status !== 'pending') {
          sendJson(res, 400, { error: `Cannot cancel task with status: ${task.metadata.status}` });
          return;
        }

        let body: { reason?: string } = {};
        try {
          body = await parseJsonBody<{ reason?: string }>(req);
        } catch {
          // Body is optional
        }

        const taskDir = getTaskDir(taskId);
        const progressPath = path.join(taskDir, 'progress.md');
        let killedSession = false;
        if (fs.existsSync(progressPath)) {
          const progressContent = fs.readFileSync(progressPath, 'utf-8');
          const tmuxMatch = progressContent.match(/tmux:\s*(cc-daemon-task-[a-f0-9]+-\d+)/);
          if (tmuxMatch) {
            const sessionName = tmuxMatch[1];
            try {
              if (await tmuxSessionExists(sessionName)) {
                await killTmuxSession(sessionName);
                killedSession = true;
                console.log(`[GUI] Killed tmux session: ${sessionName}`);
              }
            } catch (e) {
              console.error(`[GUI] Failed to kill tmux session ${sessionName}:`, e);
            }
          }
        }

        if (!killedSession) {
          const sessions = await listCcDaemonSessions();
          const taskIdPrefix = taskId.slice(0, 8);
          const matchingSession = sessions.find(s => s.includes(`-${taskIdPrefix}-`));
          if (matchingSession) {
            try {
              await killTmuxSession(matchingSession);
              console.log(`[GUI] Killed tmux session by pattern: ${matchingSession}`);
            } catch (e) {
              console.error(`[GUI] Failed to kill tmux session ${matchingSession}:`, e);
            }
          }
        }

        await taskManager.updateMetadata(taskId, { status: 'cancelled' });

        if (body.reason) {
          await taskManager.updateProgress(taskId, (progress) => {
            progress.blockers.push(`Cancelled: ${body.reason}`);
            return progress;
          });
        }

        sendJson(res, 200, { success: true, message: 'Task cancelled' });
        return;
      }

      // POST /api/tasks/:taskId/verify - Verify a task
      const verifyMatch = url.pathname.match(/^\/api\/tasks\/([^\/]+)\/verify$/);
      if (verifyMatch && method === 'POST') {
        const taskId = verifyMatch[1];
        const task = await taskManager.getTask(taskId);
        if (!task) {
          sendJson(res, 404, { error: 'Task not found' });
          return;
        }

        let body: { maxCycles?: number; timeout?: number } = {};
        try {
          body = await parseJsonBody<{ maxCycles?: number; timeout?: number }>(req);
        } catch {
          // Body is optional, use defaults
        }

        verifyTask(taskId, {
          maxCycles: body.maxCycles || 3,
          timeout: body.timeout || 600000,
          onProgress: () => {}
        }).then(result => {
          console.log(`Verification complete for ${taskId}: ${result.passed ? 'PASSED' : 'FAILED'}`);
        }).catch(error => {
          console.error(`Verification error for ${taskId}:`, error);
        });

        sendJson(res, 200, {
          success: true,
          message: 'Verification started',
          taskId
        });
        return;
      }

      // DELETE /api/tasks/:taskId - Delete a task
      const deleteMatch = url.pathname.match(/^\/api\/tasks\/([^\/]+)$/);
      if (deleteMatch && method === 'DELETE') {
        const taskId = deleteMatch[1];
        const task = await taskManager.getTask(taskId);
        if (!task) {
          sendJson(res, 404, { error: 'Task not found' });
          return;
        }

        if (task.metadata.status === 'active' || task.metadata.status === 'pending') {
          sendJson(res, 400, { error: 'Cannot delete active or pending tasks. Cancel first.' });
          return;
        }

        await taskManager.deleteTask(taskId);
        sendJson(res, 200, { success: true, message: 'Task deleted' });
        return;
      }

      // GET /api/sessions/tmux - List tmux sessions
      if (url.pathname === '/api/sessions/tmux' && method === 'GET') {
        const sessions = await getTmuxSessionsInfo();
        sendJson(res, 200, sessions);
        return;
      }

      // GET /api/sessions/active - List active sessions
      if (url.pathname === '/api/sessions/active' && method === 'GET') {
        const sessions = await getActiveSessionsInfo();
        sendJson(res, 200, sessions);
        return;
      }

      // GET /api/sessions/tmux/:name/output - Get tmux session output
      const tmuxOutputMatch = url.pathname.match(/^\/api\/sessions\/tmux\/([^\/]+)\/output$/);
      if (tmuxOutputMatch && method === 'GET') {
        const sessionName = decodeURIComponent(tmuxOutputMatch[1]);

        if (!sessionName.startsWith('cc-daemon-')) {
          sendJson(res, 400, { error: 'Not a cc-daemon session' });
          return;
        }

        if (!(await isTmuxAvailable())) {
          sendJson(res, 400, { error: 'tmux is not available' });
          return;
        }

        if (!(await tmuxSessionExists(sessionName))) {
          sendJson(res, 404, { error: 'Session not found' });
          return;
        }

        try {
          const content = await captureTmuxPane(sessionName);
          sendJson(res, 200, { content, sessionName });
        } catch (error) {
          sendJson(res, 500, { error: `Failed to capture output: ${error}` });
        }
        return;
      }

      // POST /api/sessions/tmux/:name/attach - Open terminal to attach to tmux session
      const tmuxAttachMatch = url.pathname.match(/^\/api\/sessions\/tmux\/([^\/]+)\/attach$/);
      if (tmuxAttachMatch && method === 'POST') {
        const sessionName = decodeURIComponent(tmuxAttachMatch[1]);

        if (!sessionName.startsWith('cc-daemon-')) {
          sendJson(res, 400, { error: 'Not a cc-daemon session' });
          return;
        }

        if (!(await isTmuxAvailable())) {
          sendJson(res, 400, { error: 'tmux is not available' });
          return;
        }

        if (!(await tmuxSessionExists(sessionName))) {
          sendJson(res, 404, { error: 'Session not found' });
          return;
        }

        try {
          const attachCommand = `tmux -L cc-daemon attach -t ${sessionName}`;
          const platform = process.platform;
          let openCommand: string;
          let needsManualRun = false;

          if (platform === 'darwin') {
            // Write a .command file and open it with `open`.
            // This uses the user's own Terminal.app profile (unlike osascript `do script`
            // which opens with the default profile and a different environment, causing
            // ANSI color state to bleed across the screen as content scrolls).
            const scriptPath = path.join(os.tmpdir(), `cc-daemon-attach-${Date.now()}.command`);
            const scriptContent = [
              '#!/bin/bash',
              '# Reset terminal color state before attaching to avoid color bleed',
              'printf "\\033[0m"',
              `export TERM=xterm-256color`,
              `exec ${attachCommand}`,
            ].join('\n') + '\n';
            fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
            const { exec } = await import('child_process');
            await new Promise<void>((resolve, reject) => {
              exec(`open "${scriptPath}"`, (error) => {
                if (error) reject(error);
                else resolve();
              });
            });
          } else {
            needsManualRun = true;
          }

          sendJson(res, 200, {
            success: true,
            sessionName,
            attachCommand,
            openedTerminal: !needsManualRun,
            message: needsManualRun
              ? 'Copy and run the attach command in a terminal'
              : 'Terminal window opened'
          });
        } catch (error) {
          sendJson(res, 500, { error: `Failed to open terminal: ${error}` });
        }
        return;
      }

      // POST /api/sessions/tmux/:name/kill - Kill a tmux session
      const tmuxKillMatch = url.pathname.match(/^\/api\/sessions\/tmux\/([^\/]+)\/kill$/);
      if (tmuxKillMatch && method === 'POST') {
        const sessionName = decodeURIComponent(tmuxKillMatch[1]);

        if (!sessionName.startsWith('cc-daemon-')) {
          sendJson(res, 400, { error: 'Not a cc-daemon session' });
          return;
        }

        if (!(await isTmuxAvailable())) {
          sendJson(res, 400, { error: 'tmux is not available' });
          return;
        }

        if (!(await tmuxSessionExists(sessionName))) {
          sendJson(res, 404, { error: 'Session not found' });
          return;
        }

        try {
          await killTmuxSession(sessionName);
          sendJson(res, 200, { success: true, sessionName, message: 'Session killed' });
        } catch (error) {
          sendJson(res, 500, { error: `Failed to kill session: ${error}` });
        }
        return;
      }

      // POST /api/sessions/tmux/:name/send - Send command to tmux session
      const tmuxSendMatch = url.pathname.match(/^\/api\/sessions\/tmux\/([^\/]+)\/send$/);
      if (tmuxSendMatch && method === 'POST') {
        const sessionName = decodeURIComponent(tmuxSendMatch[1]);

        if (!sessionName.startsWith('cc-daemon-')) {
          sendJson(res, 400, { error: 'Not a cc-daemon session' });
          return;
        }

        if (!(await isTmuxAvailable())) {
          sendJson(res, 400, { error: 'tmux is not available' });
          return;
        }

        if (!(await tmuxSessionExists(sessionName))) {
          sendJson(res, 404, { error: 'Session not found' });
          return;
        }

        try {
          const body = await parseJsonBody<{ command: string }>(req);
          const command = body.command;

          if (!command) {
            sendJson(res, 400, { error: 'Command is required' });
            return;
          }

          const { exec } = await import('child_process');
          const sendCommand = `tmux -L cc-daemon send-keys -t ${sessionName} "${command.replace(/"/g, '\\"')}" Enter`;

          await new Promise<void>((resolve, reject) => {
            exec(sendCommand, (error) => {
              if (error) reject(error);
              else resolve();
            });
          });

          sendJson(res, 200, {
            success: true,
            sessionName,
            command,
            message: 'Command sent successfully'
          });
        } catch (error) {
          sendJson(res, 500, { error: `Failed to send command: ${error}` });
        }
        return;
      }

      // GET /api/stats - Get dashboard statistics
      if (url.pathname === '/api/stats' && method === 'GET') {
        const allTasks = await taskManager.listTasks();
        const activeSessions = findAllActiveSessions();

        const stats = {
          total: allTasks.length,
          active: allTasks.filter(t => t.status === 'active').length,
          pending: allTasks.filter(t => t.status === 'pending').length,
          completed: allTasks.filter(t => t.status === 'completed').length,
          failed: allTasks.filter(t => t.status === 'failed').length,
          cancelled: allTasks.filter(t => t.status === 'cancelled').length,
          totalTokens: allTasks.reduce((sum, t) => sum + (t.totalTokens || 0), 0),
          totalCost: allTasks.reduce((sum, t) => sum + (t.totalCost || 0), 0),
          activeClaudeSessions: activeSessions.length
        };

        sendJson(res, 200, stats);
        return;
      }

      // GET /api/context - Get context usage
      if (url.pathname === '/api/context' && method === 'GET') {
        const sessions = await getActiveSessionsInfo();
        sendJson(res, 200, sessions);
        return;
      }

      // GET /api/auto-trigger - Get auto-trigger monitor status
      if (url.pathname === '/api/auto-trigger' && method === 'GET') {
        const monitor = getAutoTriggerMonitor();
        sendJson(res, 200, {
          enabled: monitor?.isRunning() || false,
          sessions: monitor ? Object.fromEntries(monitor.getSessionStates()) : {}
        });
        return;
      }

      // POST /api/auto-trigger - Update auto-trigger monitor
      if (url.pathname === '/api/auto-trigger' && method === 'POST') {
        const body = await parseJsonBody<{ enabled: boolean; interval?: number }>(req);

        if (body.enabled) {
          startAutoTriggerMonitoring({
            pollInterval: (body.interval || 60) * 1000,
            onStatusChange: (sessionName, status) => {
              console.log(`[AutoTrigger] ${sessionName}: ${status.status} - ${status.reason}`);
            },
            onTrigger: (sessionName, trigger) => {
              console.log(`[AutoTrigger] Sent trigger to ${sessionName}: ${trigger}`);
            }
          });
        } else {
          stopAutoTriggerMonitoring();
        }

        sendJson(res, 200, {
          success: true,
          enabled: body.enabled
        });
        return;
      }

      // POST /api/ralph - Start Ralph Loop with optional tmux
      if (url.pathname === '/api/ralph' && method === 'POST') {
        const body = await parseJsonBody<{
          goal: string;
          completionPromise?: string;
          maxIterations?: number;
          thresholdPercent?: number;
          steps?: string[];
          tmux?: boolean;
          dryRun?: boolean;
          workingDir?: string;
          ralphLoop?: boolean;
        }>(req);

        if (!body.goal) {
          sendJson(res, 400, { error: 'Goal is required' });
          return;
        }

        if (!(await isClaudeAvailable())) {
          sendJson(res, 400, { error: 'Claude CLI is not available. Please install it first.' });
          return;
        }

        if (body.tmux && !(await isTmuxAvailable())) {
          sendJson(res, 400, { error: 'tmux is not available. Install tmux or disable tmux option.' });
          return;
        }

        const completionPromise = body.completionPromise || 'TASK_COMPLETE';

        const metadata = await taskManager.createTask(body.goal, {
          completionPromise,
          maxIterations: body.maxIterations || 100,
          thresholdPercent: body.thresholdPercent || 80,
          steps: body.steps
        });

        if (!body.dryRun) {
          const useTmux = body.tmux !== false;

          if (useTmux) {
            const executor = new TmuxRalphExecutor({
              completionPromise,
              maxIterations: body.maxIterations || 100,
              thresholdPercent: body.thresholdPercent || 80,
              verbose: false,
              workingDir: resolveWorkingDir(body.workingDir),
              ralphLoopMode: body.ralphLoop || false,
              onProgress: (_event: RalphProgressEvent) => {
                // Progress events are handled internally
              }
            });

            executor.start(metadata.id).catch((err: unknown) => {
              console.error(`[GUI] Ralph Loop error for task ${metadata.id}:`, err);
            });
          } else {
            const executor = new RalphExecutor({
              completionPromise,
              maxIterations: body.maxIterations || 100,
              thresholdPercent: body.thresholdPercent || 80,
              onProgress: (_event: ProgressEvent) => {
                // Progress events are handled internally
              }
            });

            executor.start(metadata.id).catch((err: unknown) => {
              console.error(`[GUI] Ralph Loop error for task ${metadata.id}:`, err);
            });
          }
        }

        sendJson(res, 201, {
          success: true,
          taskId: metadata.id,
          metadata,
          message: body.dryRun ? 'Task created (dry run)' : `Task created and started${body.tmux !== false ? ' in tmux' : ''}`
        });
        return;
      }

      // ========== Static Files ==========

      // Serve static files from gui/static directory
      const staticDir = path.join(__dirname, 'static');
      let filePath = path.join(staticDir, url.pathname === '/' ? 'index.html' : url.pathname);

      // Security: prevent directory traversal
      if (!filePath.startsWith(staticDir)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      // Check if file exists
      if (!fs.existsSync(filePath)) {
        // For SPA, serve index.html for unknown routes
        if (!url.pathname.startsWith('/api')) {
          filePath = path.join(staticDir, 'index.html');
          if (!fs.existsSync(filePath)) {
            res.writeHead(404);
            res.end('Not found');
            return;
          }
        } else {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
      }

      // Determine content type
      const ext = path.extname(filePath);
      const contentTypes: Record<string, string> = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.json': 'application/json',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon'
      };
      const contentType = contentTypes[ext] || 'application/octet-stream';

      const content = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);

    } catch (error) {
      console.error('GUI server error:', error);
      sendJson(res, 500, { error: String(error) });
    }
  });

  return server;
}

/**
 * Start GUI server
 */
export async function startGuiServer(options: GuiOptions = {}): Promise<http.Server> {
  const port = options.port || 9876;
  const host = options.host || 'localhost';

  const server = createGuiServer(options);

  // Use noServer mode for both WebSocketServers and dispatch upgrades manually.
  // Using { server, path } on two separate WebSocketServer instances causes both to
  // receive the same 'upgrade' event: the second one sends an HTTP 400 on the
  // already-upgraded socket, which corrupts the WebSocket frame (RSV1 must be clear).
  const wss = new WebSocketServer({ noServer: true });

  // Store connected clients
  const clients = new Set<WebSocket>();

  // Session output streaming subscriptions
  const sessionSubscriptions = new Map<WebSocket, Set<string>>();
  let sessionStreamInterval: ReturnType<typeof setInterval> | null = null;

  // Broadcast session outputs to subscribed clients
  const broadcastSessionOutputs = async () => {
    for (const [client, sessions] of sessionSubscriptions) {
      if (client.readyState !== WebSocket.OPEN) continue;

      for (const sessionName of sessions) {
        try {
          if (await tmuxSessionExists(sessionName)) {
            const content = await captureTmuxPane(sessionName);
            const message = JSON.stringify({
              type: 'sessionOutput',
              data: { sessionName, content },
              timestamp: Date.now()
            });
            client.send(message);
          }
        } catch {
          // Session might have ended, ignore errors
        }
      }
    }
  };

  wss.on('connection', (ws) => {
    clients.add(ws);
    sessionSubscriptions.set(ws, new Set());
    console.log('[GUI] WebSocket client connected');

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        const subscriptions = sessionSubscriptions.get(ws);

        if (message.type === 'subscribeSession' && message.sessionName && subscriptions) {
          subscriptions.add(message.sessionName);
          console.log(`[GUI] Client subscribed to session: ${message.sessionName}`);

          if (!sessionStreamInterval) {
            sessionStreamInterval = setInterval(async () => {
              await broadcastSessionOutputs();
            }, 1000);
          }
        }

        if (message.type === 'unsubscribeSession' && message.sessionName && subscriptions) {
          subscriptions.delete(message.sessionName);
          console.log(`[GUI] Client unsubscribed from session: ${message.sessionName}`);
        }
      } catch (error) {
        console.error('[GUI] Error handling WebSocket message:', error);
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      sessionSubscriptions.delete(ws);
      console.log('[GUI] WebSocket client disconnected');

      let totalSubscriptions = 0;
      sessionSubscriptions.forEach((subs) => {
        totalSubscriptions += subs.size;
      });
      if (totalSubscriptions === 0 && sessionStreamInterval) {
        clearInterval(sessionStreamInterval);
        sessionStreamInterval = null;
      }
    });

    ws.on('error', (error) => {
      console.error('[GUI] WebSocket error:', error);
      clients.delete(ws);
      sessionSubscriptions.delete(ws);
    });
  });

  // Create WebSocket server for terminal connections (also noServer)
  const terminalWss = new WebSocketServer({ noServer: true });

  // Single upgrade handler routes connections to the correct WebSocketServer
  server.on('upgrade', (req, socket, head) => {
    const pathname = req.url?.split('?')[0] ?? '';
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else if (pathname === '/terminal') {
      terminalWss.handleUpgrade(req, socket, head, (ws) => terminalWss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  terminalWss.on('connection', (ws, _req) => {
    // Session name comes from the first message. We use node-pty to spawn a real
    // `tmux attach-session` process so xterm.js gets a true PTY stream with correct
    // ANSI sequences, resize support, and bidirectional keyboard input.
    let sessionName: string | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let ptyProcess: any = null;

    const startPty = async (name: string, cols: number, rows: number) => {
      if (!(await tmuxSessionExists(name))) {
        ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
        ws.close();
        return;
      }

      try {
        // Use Python's pty module as a PTY broker (node-pty requires native entitlements
        // that may not be available on all macOS builds).
        const helperPath = path.join(__dirname, 'static', 'pty_helper.py');
        const { spawn } = await import('child_process');

        ptyProcess = spawn('python3', [
          helperPath,
          String(cols), String(rows),
          'tmux', '-L', 'cc-daemon', 'attach-session', '-t', name,
        ], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, TERM: 'xterm-256color' },
        });

        // Stream raw PTY bytes to xterm.js
        ptyProcess.stdout!.on('data', (chunk: Buffer) => {
          if (ws.readyState === WebSocket.OPEN) {
            // Send as Latin-1 string so binary bytes survive JSON serialisation
            ws.send(JSON.stringify({ type: 'output', content: chunk.toString('binary') }));
          }
        });

        ptyProcess.stderr!.on('data', (chunk: Buffer) => {
          console.error(`[GUI] PTY stderr: ${chunk.toString()}`);
        });

        ptyProcess.on('exit', () => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', message: 'Session ended' }));
            ws.close();
          }
        });

        console.log(`[GUI] PTY attached to session: ${name} (${cols}x${rows})`);
      } catch (err) {
        console.error('[GUI] Failed to spawn PTY:', err);
        ws.send(JSON.stringify({ type: 'error', message: `Failed to attach: ${err}` }));
        ws.close();
      }
    };

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());

        // First message must be session handshake
        if (!sessionName) {
          if (message.type !== 'session' || !message.session) {
            ws.close(1008, 'Expected session handshake as first message');
            return;
          }
          const name = String(message.session);
          if (!name.startsWith('cc-daemon-')) {
            ws.close(1008, 'Invalid session name');
            return;
          }
          sessionName = name;
          const cols = Number(message.cols) || 220;
          const rows = Number(message.rows) || 50;
          await startPty(sessionName, cols, rows);
          return;
        }

        // Keyboard input → PTY stdin (raw bytes)
        if (message.type === 'input' && message.data && ptyProcess) {
          ptyProcess.stdin!.write(Buffer.from(message.data as string, 'binary'));
          return;
        }

        // Resize → send escape sequence to PTY helper: \x01{cols}x{rows}\n
        if (message.type === 'resize' && message.cols && message.rows && ptyProcess) {
          const resizeCmd = `\x01${message.cols}x${message.rows}\n`;
          ptyProcess.stdin!.write(resizeCmd);
          return;
        }
      } catch (error) {
        console.error('[GUI] Error handling terminal message:', error);
      }
    });

    ws.on('close', () => {
      if (ptyProcess) {
        ptyProcess.kill();
        ptyProcess = null;
      }
      console.log(`[GUI] Terminal disconnected from session: ${sessionName ?? 'unknown'}`);
    });

    ws.on('error', (error) => {
      console.error(`[GUI] Terminal WebSocket error for ${sessionName ?? 'unknown'}:`, error);
    });
  });

  // Broadcast function for real-time updates
  const broadcast = (type: string, data: unknown) => {
    const message = JSON.stringify({ type, data, timestamp: Date.now() });
    clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  };

  // Set up periodic broadcasting of stats
  const broadcastInterval = setInterval(async () => {
    try {
      const stats = await getStats();
      broadcast('stats', stats);
    } catch (error) {
      console.error('[GUI] Error broadcasting stats:', error);
    }
  }, 5000);

  // Clean up on server close
  server.on('close', () => {
    clearInterval(broadcastInterval);
    wss.close();
    terminalWss.close();
    stopAutoTriggerMonitoring();
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      console.log(`\n╔══════════════════════════════════════════════╗`);
      console.log(`║       CC-Daemon GUI Server Started          ║`);
      console.log(`╠══════════════════════════════════════════════╣`);
      console.log(`║  URL: http://${host}:${port}                   ║`);
      console.log(`║  WebSocket: ws://${host}:${port}               ║`);
      console.log(`║  Press Ctrl+C to stop                       ║`);
      console.log(`╚══════════════════════════════════════════════╝\n`);
      resolve(server);
    });
  });
}
