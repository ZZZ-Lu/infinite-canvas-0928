import type { AgentHistoryItem, AgentToolCall, AgentTurnResult } from './protocol';

export type RuntimeTaskStatus = 'planning' | 'waiting_tools' | 'waiting_user' | 'completed' | 'failed' | 'cancelled' | 'paused';
export type RuntimeToolStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface RuntimeEvent {
  id: string;
  taskId: string;
  turnId: string;
  type: 'user' | 'thought' | 'tool' | 'answer' | 'system';
  text: string;
  toolName?: string;
  callId?: string;
  status?: RuntimeToolStatus;
  input?: Record<string, unknown>;
  output?: unknown;
  error?: string;
  createdAt: number;
}

export interface RuntimeTask {
  id: string;
  sessionId: string;
  goal: string;
  title: string;
  status: RuntimeTaskStatus;
  turn: number;
  summary: string;
  subGoal?: string;
  progress: string;
  notes?: string;
  observations: AgentHistoryItem[];
  plan: Array<{ id: string; title: string; status: 'pending' | 'completed' }>;
  history: AgentHistoryItem[];
  events: RuntimeEvent[];
  pendingCallIds: string[];
  negotiationLog: Array<{ role: 'user' | 'agent', content: string, timestamp: number }>;
  lastGoalUpdatedAt: number;
  lastUserInputAt: number;
  images?: string[];
  cardContext?: Record<string, any>;
}

export interface AgentRuntimeOptions {
  requestTurn: (task: RuntimeTask, requireTool: boolean, signal?: AbortSignal) => Promise<AgentTurnResult>;
  executeTool: (call: AgentToolCall, task: RuntimeTask, signal?: AbortSignal) => Promise<unknown>;
  updateStateNode?: (task: RuntimeTask, result: AgentTurnResult, signal?: AbortSignal) => Promise<void>;
  onTaskChange?: (task: RuntimeTask) => void;
  maxTurns?: number;
  /** Full Theater V1: a task must include one successful, Agent-selected UI action before completion. */
  requireVisibleInteraction?: boolean;
  /** Returns true only for tools that may run alongside other read-only tools. */
  isParallelSafe?: (call: AgentToolCall) => boolean;
}

const terminal = new Set<RuntimeTaskStatus>(['completed', 'failed', 'cancelled']);

/**
 * The sole owner of task progress. It is intentionally independent from React
 * and DOM: UI state changes are exposed only as tools supplied by the host.
 */
export class AgentRuntime {
  private readonly tasks = new Map<string, RuntimeTask>();
  private readonly running = new Set<string>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly options: Required<Pick<AgentRuntimeOptions, 'maxTurns'>> & AgentRuntimeOptions;

  constructor(options: AgentRuntimeOptions) {
    this.options = { ...options, maxTurns: options.maxTurns ?? 12 };
  }

  createTask(input: { id: string; sessionId: string; goal: string; images?: string[]; cardContext?: Record<string, any> }): RuntimeTask {
    const task: RuntimeTask = {
      id: input.id,
      sessionId: input.sessionId,
      goal: '',
      title: '尚未命名',
      status: 'planning',
      turn: 0,
      summary: '',
      progress: '',
      observations: [],
      plan: [],
      history: [],
      events: [],
      pendingCallIds: [],
      negotiationLog: [{ role: 'user', content: input.goal, timestamp: Date.now() }],
      lastGoalUpdatedAt: 0,
      lastUserInputAt: Date.now(),
      images: input.images,
      cardContext: input.cardContext,
    };
    this.tasks.set(task.id, task);
    this.addEvent(task, { type: 'user', text: input.goal });
    return task;
  }

  getTask(taskId: string): RuntimeTask | undefined {
    return this.tasks.get(taskId);
  }

  addUserInput(taskId: string, input: string, images?: string[], cardContext?: Record<string, any>) {
    const task = this.requireTask(taskId);
    task.negotiationLog.push({ role: 'user', content: input, timestamp: Date.now() });
    task.lastUserInputAt = Date.now();
    if (images && images.length > 0) {
      task.images = images;
    }
    if (cardContext) {
      task.cardContext = cardContext;
    }
    this.addEvent(task, { type: 'user', text: input });
    // If it was waiting, completed, or paused, resume it
    if (task.status === 'waiting_user' || terminal.has(task.status) || task.status === 'paused') {
      task.status = 'planning';
    }
  }

  addAgentQuestion(taskId: string, question: string) {
    const task = this.requireTask(taskId);
    task.negotiationLog.push({ role: 'agent', content: question, timestamp: Date.now() });
  }

  private isInterrupted(task: RuntimeTask, signal?: AbortSignal): boolean {
    const status = task.status as RuntimeTaskStatus;
    return status === 'paused' || terminal.has(status) || Boolean(signal?.aborted);
  }

  async wake(taskId: string): Promise<RuntimeTask> {
    const task = this.requireTask(taskId);
    if ((task.status as RuntimeTaskStatus) === 'cancelled' || this.running.has(taskId)) return task;
    // If task was paused, completed, or waiting_user, unfreeze it to planning so the ReAct loop executes
    if (task.status === 'paused' || task.status === 'completed' || task.status === 'waiting_user') {
      task.status = 'planning';
    }
    this.running.add(taskId);
    let controller = this.abortControllers.get(taskId);
    if (!controller || controller.signal.aborted) {
      controller = new AbortController();
      this.abortControllers.set(taskId, controller);
    }
    const signal = controller.signal;

    try {
      let recoveryCount = 0;
      while (!terminal.has(task.status) && (task.status as RuntimeTaskStatus) !== 'paused' && !signal.aborted) {
        task.turn += 1;
        task.status = 'planning';
        const turnId = `${task.id}:turn:${task.turn}`;
        this.publish(task);

        const result = await this.options.requestTurn(task, recoveryCount > 0, signal);

        // Check if user paused or cancelled while requestTurn was in-flight
        if (this.isInterrupted(task, signal)) {
          break;
        }

        // The debug transport snapshot is for the developer trace only. It
        // must never become part of the next model request's history.
        // Results are delivered once. Only explicit failure lessons persist.
        task.observations = [];
        result.narration.forEach(text => this.addEvent(task, { turnId, type: 'thought', text }));
        const fullAnswer = result.fullAnswer || result.response || result.speak;
        if (fullAnswer) {
          this.addEvent(task, { turnId, type: 'answer', text: fullAnswer });
        }

        // Dedicated State Node: Automatically extract and update cognitive state after every turn's output
        if (this.options.updateStateNode && !this.isInterrupted(task, signal)) {
          try {
            await this.options.updateStateNode(task, result, signal);
          } catch (nodeErr) {
            console.warn('Dedicated state node execution failed:', nodeErr);
          }
        }

        if (result.complete) {
          task.status = 'completed';
          if (result.speak) task.summary = result.speak;
          this.publish(task);
          break;
        }

        if (result.toolCalls.length === 0 && !this.isInterrupted(task, signal)) {
          task.status = 'completed';
          if (result.speak) task.summary = result.speak;
          this.publish(task);
          break;
        }

        if (this.isInterrupted(task, signal)) {
          break;
        }

        recoveryCount = 0;
        task.status = 'waiting_tools';
        task.pendingCallIds = result.toolCalls.map(call => call.id);
        this.publish(task);

        // Preserve explicit Agent ordering around UI mutations. Consecutive
        // read-only calls can run together so guide.lookup + page.inspect do
        // not cost two model-round delays.
        let readBatch: AgentToolCall[] = [];
        const flushReadBatch = async () => {
          if (!readBatch.length) return;
          const batch = readBatch;
          readBatch = [];
          if (this.isInterrupted(task, signal)) return;
          await Promise.all(batch.map(call => this.runTool(task, turnId, call, signal)));
        };
        for (const call of result.toolCalls) {
          if (this.isInterrupted(task, signal)) break;
          if (this.options.isParallelSafe?.(call)) {
            readBatch.push(call);
            continue;
          }
          await flushReadBatch();
          if (this.isInterrupted(task, signal)) break;
          await this.runTool(task, turnId, call, signal);
          if (this.isInterrupted(task, signal)) break;
        }
        if (!this.isInterrupted(task, signal)) {
          await flushReadBatch();
        }
        task.pendingCallIds = [];

        this.publish(task);
      }
    } catch (error) {
      if ((task.status as RuntimeTaskStatus) === 'cancelled' || signal.aborted) {
        task.status = 'cancelled';
        this.publish(task);
      } else if ((task.status as RuntimeTaskStatus) === 'paused') {
        this.publish(task);
      } else {
        task.status = 'failed';
        const message = error instanceof Error ? error.message : 'Agent 执行失败';
        this.addEvent(task, { type: 'answer', text: message, error: message });
        this.publish(task);
      }
    } finally {
      this.running.delete(taskId);
      if ((task.status as RuntimeTaskStatus) !== 'paused') {
        this.abortControllers.delete(taskId);
      }
    }
    return task;
  }

  pause(taskId: string) {
    const task = this.requireTask(taskId);
    if (!terminal.has(task.status) && task.status !== 'paused') {
      task.status = 'paused';
      this.addEvent(task, { type: 'system', text: '任务已暂停。' });
      this.publish(task);
    }
  }

  async resume(taskId: string): Promise<RuntimeTask> {
    const task = this.requireTask(taskId);
    if (task.status === 'paused') {
      task.status = 'planning';
      this.addEvent(task, { type: 'system', text: '任务已继续执行。' });
      this.publish(task);
      return this.wake(taskId);
    }
    return task;
  }

  cancel(taskId: string) {
    const task = this.requireTask(taskId);
    if (!terminal.has(task.status)) {
      task.status = 'cancelled';
      const controller = this.abortControllers.get(taskId);
      if (controller) {
        controller.abort();
        this.abortControllers.delete(taskId);
      }
      this.addEvent(task, { type: 'system', text: '任务已取消。' });
      this.publish(task);
    }
  }

  private async runTool(task: RuntimeTask, turnId: string, call: AgentToolCall, signal?: AbortSignal) {
    this.addEvent(task, { turnId, type: 'tool', text: `调用中：${call.name}`, toolName: call.name, callId: call.id, status: 'queued', input: call.arguments });
    this.updateLastTool(task, call.id, 'running', `调用中：${call.name}`);
    
    if (call.name === 'sys.updateState') {
      if (typeof call.arguments.progress === 'string') task.progress = call.arguments.progress;
      if (typeof call.arguments.subGoal === 'string') task.subGoal = call.arguments.subGoal;
      if (typeof call.arguments.taskTitle === 'string') task.title = call.arguments.taskTitle;
      if (typeof call.arguments.goal === 'string') {
        task.goal = call.arguments.goal;
        task.lastGoalUpdatedAt = Date.now();
      }
      let rawNotes = call.arguments.notes;
      if (Array.isArray(rawNotes)) {
        rawNotes = rawNotes.join('\n');
      }
      if (typeof rawNotes === 'string') {
        const mode = call.arguments.notesMode || call.arguments.mode;
        if (mode === 'overwrite' || mode === 'replace' || mode === 'rewrite') {
          task.notes = rawNotes;
        } else {
          task.notes = task.notes ? task.notes + '\n' + rawNotes : rawNotes;
        }
      } else if (typeof call.arguments.overwriteNotes === 'string') {
        task.notes = call.arguments.overwriteNotes;
      } else if (typeof call.arguments.appendNotes === 'string') {
        task.notes = task.notes ? task.notes + '\n' + call.arguments.appendNotes : call.arguments.appendNotes;
      }
      if (Array.isArray(call.arguments.plan)) task.plan = call.arguments.plan.map((item: any) => ({ ...item, status: item.status || 'pending' }));
      this.updateLastTool(task, call.id, 'succeeded', `已完成：${call.name}`, { output: '状态已持久化' });
      task.observations.push({ role: 'tool', content: { callId: call.id, name: call.name, status: 'succeeded', output: '状态已持久化' } });
      return;
    }

    if (call.name === 'sys.endTask') {
      const responseText = typeof call.arguments.finalResponse === 'string' ? call.arguments.finalResponse : '';
      const responseSuggestsPending = /后台|渲染|排队|稍候|生成中|等待生成|正在生成|提交生成/i.test(responseText);

      // Check if recent observations or tool calls in this task contain active pending card.generate
      const hasRecentPendingGeneration = task.observations.some(obs => {
        const content = obs.content as any;
        const out = content?.output;
        return content?.name === 'card.generate' && (
          out?.cardState === 'generating' ||
          out?.status === 'pending' ||
          out?.autoStarted === true
        );
      }) || task.events.some(e => e.toolName === 'card.generate' && (e.status === 'succeeded' || e.status === 'running'));

      const isPaused = Boolean(
        call.arguments.paused ||
        call.arguments.isPaused ||
        call.arguments.status === 'paused' ||
        hasRecentPendingGeneration ||
        responseSuggestsPending
      );

      if (typeof call.arguments.waitForUser === 'string' && call.arguments.waitForUser) {
        task.status = 'waiting_user';
        const hasAnswer = task.events.some(e => e.turnId === turnId && e.type === 'answer');
        if (!hasAnswer) {
          this.addEvent(task, { turnId, type: 'answer', text: call.arguments.waitForUser });
        }
      } else if (isPaused) {
        task.status = 'paused';
        const response = typeof call.arguments.finalResponse === 'string' ? call.arguments.finalResponse : '任务已挂起暂停，等待后台事件唤醒。';
        const hasAnswer = task.events.some(e => e.turnId === turnId && e.type === 'answer');
        if (!hasAnswer) {
          this.addEvent(task, { turnId, type: 'answer', text: response });
        }
        task.summary = response || task.summary;
      } else {
        task.status = 'completed';
        const response = typeof call.arguments.finalResponse === 'string' ? call.arguments.finalResponse : '任务完成。';
        const existingAnswer = task.events.find(e => e.turnId === turnId && e.type === 'answer');
        if (!existingAnswer) {
          this.addEvent(task, { turnId, type: 'answer', text: response });
        } else if (response && response !== '任务完成。') {
          existingAnswer.text = response;
        }
        task.summary = response || task.summary;
      }
      this.updateLastTool(task, call.id, 'succeeded', `已完成：${call.name}`, { output: '任务已结束' });
      this.publish(task);
      return;
    }

    try {
      const output = await this.options.executeTool(call, task, signal);
      if (task.status === 'paused' || terminal.has(task.status) || signal?.aborted) return;
      this.updateLastTool(task, call.id, 'succeeded', `已完成：${call.name}`, { output });
      task.observations.push({ role: 'tool', content: { callId: call.id, name: call.name, status: 'succeeded', output } });
    } catch (error) {
      if (task.status === 'cancelled' || signal?.aborted) return;
      const message = error instanceof Error ? error.message : '工具执行失败';
      this.updateLastTool(task, call.id, 'failed', `失败：${call.name} · ${message}`, { error: message });
      task.history.push({ role: 'tool', content: { callId: call.id, name: call.name, status: 'failed', error: message } });
      task.observations.push({ role: 'tool', content: { callId: call.id, name: call.name, status: 'failed', error: message } });
    }
  }

  addFeedback(taskId: string, text: string, type: 'answer' | 'system' = 'answer') {
    const task = this.tasks.get(taskId);
    if (!task) return;
    this.addEvent(task, { type, text });
  }

  notifyTaskUpdated(taskId: string) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    this.publish(task);
  }

  private addEvent(task: RuntimeTask, partial: Omit<RuntimeEvent, 'id' | 'taskId' | 'turnId' | 'createdAt'> & { turnId?: string }) {
    task.events.push({ id: `${Date.now()}_${Math.random().toString(36).slice(2)}`, taskId: task.id, turnId: partial.turnId || `${task.id}:system`, createdAt: Date.now(), ...partial });
    task.events = task.events.slice(-80);
    this.publish(task);
  }

  private updateLastTool(task: RuntimeTask, callId: string, status: RuntimeToolStatus, text: string, extra: Pick<RuntimeEvent, 'output' | 'error'> = {}) {
    const event = [...task.events].reverse().find(item => item.callId === callId);
    if (event) Object.assign(event, { status, text, ...extra });
    this.publish(task);
  }

  private publish(task: RuntimeTask) { this.options.onTaskChange?.({ ...task, events: [...task.events], history: [...task.history], pendingCallIds: [...task.pendingCallIds] }); }
  private requireTask(taskId: string) { const task = this.tasks.get(taskId); if (!task) throw new Error(`未知任务：${taskId}`); return task; }
}
