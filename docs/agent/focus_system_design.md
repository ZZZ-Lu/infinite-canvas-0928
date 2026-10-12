# Mira Agent Focus System Design (Mira Agent 聚焦系统架构设计)

## 核心设计原则

在 Mira Agent 系统中，必须严格遵守以下原则：

> **不打补丁，完善系统设计**
> 
> 任何交互问题、聚焦矛盾或状态混乱，严禁通过增加特例判断、临时标志位或 Patch 补丁进行修复。必须从领域职责划分、单向数据流与状态机边界层面完善底层架构设计。

---

## 1. 领域职责剥离：用户选择 vs Agent 聚焦

系统中存在两种本质不同、作用域隔离的状态：

### A. 用户选择领域 (`selectedCardIds`)
- **定义**：用户在画布上通过鼠标左键点击、Shift/Ctrl 多选或框选矩形选中的卡片集合。
- **UI 呈现**：用户态蓝色外描边（#3b82f6）。
- **生命周期**：完全由用户 GUI 操作驱动。
- **隔离不变性**：
  1. 用户选择卡片**绝对不能**自动触发或污染 `agentFocusManager`（即选择卡片不等于 Agent 正在观察/处理该卡片）。
  2. Agent 任务结束、清除聚焦（`clearAll` / `sys.endTask`）**绝对不能**修改或清空用户的 `selectedCardIds`。

### B. Agent 聚焦领域 (`agentFocusManager`)
- **定义**：Mira (Agent) 当前正在关注、观察、处理或引用的目标卡片或画布区域。
- **UI 呈现**：Agent 态紫色渐变描边、环形高亮及 HUD 状态文本（如“Mira正在处理”、“Mira引用中”）。
- **生命周期**：
  1. **Agent 工具执行**：通过 JSON 节点输出的工具调用（`page.inspect` / `card.inspect` / `card.generate` / `ui.actAndObserve` / `sys.endTask`）驱动。
  2. **用户显式召唤与委托**：
     - 用户拖拽 Agent 指针至卡片/画布。
     - 用户在卡片/多选卡片/空白画布上右键召唤 Agent 并弹出 QuickInput / 右键菜单。
     - 用户在 QuickInput 或右键菜单中向 Agent 发送指令。
- **画布聚焦模式 (Canvas Focus Mode)**：
  - 当 Agent 被召唤至空白画布时，`agentFocusManager` 进入画布聚焦模式（`primaryCardId = null`），Agent 处于全局/画布指令响应状态。

---

## 2. 真实双态共存 (Dual Co-Presence) 渲染

当同一张卡片**既被用户选中**（`isSelected = true`）**又被 Agent 聚焦**（`isAgentTarget = true`）时：
- 系统采用半用户蓝（#3b82f6）+ 半 Agent 紫（#a45cf8）对角斜向渐变描边进行双态渲染。
- 线条宽度统一收敛设置为标准选中线宽的 **0.5 倍**（DOM 层 `padding: 0.625px`，Canvas 层 `lineWidth = selectedLineWidth * 0.3375`）。

---

## 3. Agent 召唤与状态响应机制

1. **可召唤性**：除 Agent 正在实际执行任务循环（`isAgentRunning === true`）外，用户在任意时刻、任意位置（卡片、多选集、空白画布）右键均可随时召唤 Agent。
2. **任务结束收敛**：当 Agent 任务完成或取消时，仅重置 Agent 的聚焦状态与指针姿态，保持用户当前选中的卡片不变。
