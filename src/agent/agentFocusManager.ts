/**
 * Mira Agent Focus Management System
 * 
 * Standalone pure-data store that manages real-time card focus additions, removals,
 * roles (primary, reference, inspect, interact), and cursor modes.
 * Synchronizes seamlessly with:
 * 1. JSON Adapter tool execution outputs (SSOT)
 * 2. Progressive Frame-Budgeted Mounting (Preemptive Priority)
 * 3. NanoLodCanvas (Canvas Layer) and GenerationCard (DOM Layer)
 * 4. Agent Cursor Morphing (Eye, Spark, Click, Default)
 */

export type AgentFocusRole = 
  | 'inspect'    // Deep-inspecting card details, prompt or images
  | 'working'    // Actively composing / generating prompt or forking (Primary target)
  | 'reference'  // Serving as a reference asset/source (Secondary targets)
  | 'interact';  // Performing a direct mouse click/input on card components

export type AgentCursorMode = 'default' | 'inspect' | 'working' | 'interact';

export interface FocusedCardItem {
  cardId: string;
  role: AgentFocusRole;
  sourceTool: string;
  timestamp: number;
}

export interface AgentFocusSnapshot {
  focusedMap: Record<string, FocusedCardItem>;
  primaryCardId: string | null;
  referenceCardIds: string[];
  cursorMode: AgentCursorMode;
}

type FocusListener = (snapshot: AgentFocusSnapshot) => void;

class AgentFocusManager {
  private focusedMap = new Map<string, FocusedCardItem>();
  private primaryCardId: string | null = null;
  private referenceCardIds = new Set<string>();
  private cursorMode: AgentCursorMode = 'default';
  private listeners = new Set<FocusListener>();
  private fadeTimer: any = null;

  public getSnapshot(): AgentFocusSnapshot {
    const mapObj: Record<string, FocusedCardItem> = {};
    this.focusedMap.forEach((item, id) => {
      mapObj[id] = item;
    });
    return {
      focusedMap: mapObj,
      primaryCardId: this.primaryCardId,
      referenceCardIds: Array.from(this.referenceCardIds),
      cursorMode: this.cursorMode,
    };
  }

  private notify() {
    const snapshot = this.getSnapshot();
    this.listeners.forEach(fn => {
      try {
        fn(snapshot);
      } catch (err) {
        console.error('Error in focus listener:', err);
      }
    });
  }

  public subscribe(listener: FocusListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  public setCursorMode(mode: AgentCursorMode) {
    if (this.cursorMode !== mode) {
      this.cursorMode = mode;
      this.notify();
    }
  }

  public getCursorMode(): AgentCursorMode {
    return this.cursorMode;
  }

  public isFocused(cardId: string): boolean {
    return this.focusedMap.has(cardId);
  }

  public getFocusRole(cardId: string): AgentFocusRole | null {
    return this.focusedMap.get(cardId)?.role || null;
  }

  public addFocus(cardId: string, role: AgentFocusRole = 'inspect', sourceTool = 'manual') {
    if (!cardId) return;
    if (this.fadeTimer) {
      clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
    }
    this.focusedMap.set(cardId, {
      cardId,
      role,
      sourceTool,
      timestamp: Date.now(),
    });

    if (role === 'reference') {
      this.referenceCardIds.add(cardId);
    } else {
      this.primaryCardId = cardId;
    }
    this.notify();
  }

  public removeFocus(cardId: string) {
    if (!cardId) return;
    this.focusedMap.delete(cardId);
    if (this.primaryCardId === cardId) {
      this.primaryCardId = null;
    }
    this.referenceCardIds.delete(cardId);
    this.notify();
  }

  public setPrimaryFocus(cardId: string | null, role: AgentFocusRole = 'inspect', sourceTool = 'manual') {
    if (this.fadeTimer) {
      clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
    }

    if (!cardId) {
      if (this.primaryCardId) {
        this.focusedMap.delete(this.primaryCardId);
        this.primaryCardId = null;
        this.notify();
      }
      return;
    }

    // Retain references, update primary
    if (this.primaryCardId && this.primaryCardId !== cardId && !this.referenceCardIds.has(this.primaryCardId)) {
      this.focusedMap.delete(this.primaryCardId);
    }

    this.primaryCardId = cardId;
    this.focusedMap.set(cardId, {
      cardId,
      role,
      sourceTool,
      timestamp: Date.now(),
    });
    this.notify();
  }

  public batchSetFocus(options: {
    primary?: string | null;
    references?: string[];
    role?: AgentFocusRole;
    sourceTool?: string;
    cursorMode?: AgentCursorMode;
  }) {
    if (this.fadeTimer) {
      clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
    }

    this.focusedMap.clear();
    this.referenceCardIds.clear();

    const role = options.role || 'working';
    const sourceTool = options.sourceTool || 'card.generate';

    if (options.primary && options.primary !== 'new') {
      this.primaryCardId = options.primary;
      this.focusedMap.set(options.primary, {
        cardId: options.primary,
        role: role === 'working' ? 'working' : role,
        sourceTool,
        timestamp: Date.now(),
      });
    } else {
      this.primaryCardId = null;
    }

    if (Array.isArray(options.references)) {
      options.references.forEach(refId => {
        if (refId && refId !== options.primary) {
          this.referenceCardIds.add(refId);
          this.focusedMap.set(refId, {
            cardId: refId,
            role: 'reference',
            sourceTool,
            timestamp: Date.now(),
          });
        }
      });
    }

    if (options.cursorMode) {
      this.cursorMode = options.cursorMode;
    }

    this.notify();
  }

  public clearAll(delayMs: number = 0) {
    if (this.fadeTimer) {
      clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
    }

    if (delayMs > 0) {
      this.fadeTimer = setTimeout(() => {
        this.focusedMap.clear();
        this.primaryCardId = null;
        this.referenceCardIds.clear();
        this.cursorMode = 'default';
        this.fadeTimer = null;
        this.notify();
      }, delayMs);
      return;
    }

    this.focusedMap.clear();
    this.primaryCardId = null;
    this.referenceCardIds.clear();
    this.cursorMode = 'default';
    this.notify();
  }

  /**
   * Evaluates a validated tool call from the JSON adapter node
   * and dispatches focus changes instantaneously.
   */
  public handleJsonNodeToolCall(call: { name: string; arguments?: Record<string, any> }) {
    if (!call || !call.name) return;

    if (call.name === 'page.inspect') {
      this.setCursorMode('inspect');
      const scope = call.arguments?.scope;
      if (typeof scope === 'string' && scope !== 'overview') {
        const cardId = scope.startsWith('canvas.card.') 
          ? scope.replace('canvas.card.', '') 
          : (scope.startsWith('card_') ? scope : null);
        if (cardId) {
          this.setPrimaryFocus(cardId, 'inspect', 'page.inspect');
        }
      }
    } else if (call.name === 'card.inspect') {
      const cardId = call.arguments?.cardId;
      if (typeof cardId === 'string' && cardId) {
        this.setCursorMode('inspect');
        this.setPrimaryFocus(cardId, 'inspect', 'card.inspect');
      }
    } else if (call.name === 'card.generate') {
      const targetCardId = call.arguments?.targetCardId;
      const refIds: string[] = Array.isArray(call.arguments?.referenceCardIds) 
        ? call.arguments.referenceCardIds.filter((id: any): id is string => typeof id === 'string') 
        : [];
      
      this.setCursorMode('working');
      this.batchSetFocus({
        primary: typeof targetCardId === 'string' && targetCardId !== 'new' ? targetCardId : (refIds[0] || null),
        references: refIds,
        role: 'working',
        sourceTool: 'card.generate',
        cursorMode: 'working',
      });
    } else if (call.name === 'ui.actAndObserve') {
      const targetId = String(call.arguments?.targetId || '');
      this.setCursorMode('interact');
      if (targetId.startsWith('canvas.card.')) {
        const cardId = targetId.replace('canvas.card.', '');
        this.setPrimaryFocus(cardId, 'interact', 'ui.actAndObserve');
      } else if (targetId.startsWith('card_') || targetId.includes('.card.')) {
        const cardId = targetId.split('.')[0] || targetId;
        this.setPrimaryFocus(cardId, 'interact', 'ui.actAndObserve');
      }
    } else if (call.name === 'sys.endTask') {
      // Clear with 2.5s graceful fade-out
      this.clearAll(2500);
    }
  }
}

export const agentFocusManager = new AgentFocusManager();
