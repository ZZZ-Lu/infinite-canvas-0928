# Mira Agent 聚焦系统与鼠标动作系统协同设计规范 (Focus & Cursor Action Spec)

> 状态：设计方案记录（待实施）。本文档定义 Agent 聚焦系统如何与鼠标动作系统、JSON 转译节点及边框分批加载机制无缝协同。

---

## 1. 核心设计哲学与架构定位

在无限画布多人协同隐喻中，Agent 是与用户平等的“数字同事”。
* **鼠标动作系统 (Action System)**：负责表演和驱动 Agent 在物理空间中的移动、悬停、点击、输入、拖拽；
* **聚焦系统 (Focus System)**：负责管理卡片焦点的生命周期（增、删、改、查、多参考关联）；
* **JSON 转译节点 (JSON Adapter)**：作为单一真理来源 (SSOT)，输出确定性的 `tool_calls`。

**协同铁律**：聚焦不能脱离鼠标独立存在，鼠标也不能做无焦点的盲目表演。鼠标动作的时序（启程、飞行、到达、交互、离开）必须与卡片聚焦的视觉反馈（引力光晕、实线锁定、能量脉冲、平滑淡出）形成毫秒级严格对齐。

---

## 2. 状态机模型与形态映射

### 2.1 指针形态机 (Cursor Morphing)
Agent 指针在动作生命周期中自适应变幻形态：
* `default`：常态紫色小箭头（位移、巡航、待机）
* `inspect`：灵动之眼 👁️（`card.inspect`，深入读取高清图与提示词）
* `working`：创作星芒/画笔 ✨（`card.generate`，配置参数与触发生图）
* `interact`：交互手势 👆 / ✍️（`ui.actAndObserve`，点击按钮或输入提示词）

### 2.2 聚焦角色分类 (Focus Roles)
* `primary`：当前动作直接作用的主卡片（实线紫色描边 + `[ Mira ]` 铭牌）
* `reference`：作为创作参考图源的卡片集合（紫色虚线描边 + 能量引力流）
* `inspecting`：正在被审视读取的卡片（柔和紫色探针光晕）

---

## 3. 四阶段协同动作时序 (Action-Focus Chronology)

当 JSON 转译节点输出工具调用后，动作系统与聚焦系统按以下 4 阶段严格协同：

```text
[阶段 1: 意图锁定与起飞] ──(位移中 350ms)──> [阶段 2: 飞抵与空间聚焦] ──(执行交互 150ms~700ms)──> [阶段 3: 工作/生成发光] ──(完成交接)──> [阶段 4: 优雅释放]
        │                                            │                                                  │                                          │
• JSON 节点确认 tool_calls                  • 鼠标到达目标卡片视区中心                          • card.generate 触发排队/渲染              • 任务结束或转移至新卡片
• 指针变幻形态 (眼睛/星芒)                  • 聚焦系统生效: primaryCardId 激活                  • 主卡片进入 0.8s 呼吸脉冲                 • 鼠标恢复常态
• 触发抢占式挂载 (Preempt Mount)            • 卡片亮起实线紫框 + 铭牌                           • 参考卡片亮起虚线关联紫光                 • 紫色高亮 2.5s 后平滑淡出
• 动作系统启动位移 (animateMoveToTarget)
```

### 阶段 1：意图锁定与起飞（T = 0ms ~ 350ms）
1. JSON 转译节点输出结构化 `tool_calls`（如 `{ name: 'card.inspect', arguments: { cardId: 'c1' } }`）；
2. 聚焦系统与分批加载调度器联动：通知 `sortedPending` 将目标卡片 `c1` 标记为**最高优先级（Top Priority）**，触发**抢占式优先挂载**；
3. 指针形态立即变幻（如变为「眼睛 👁️」）；
4. 动作系统启动 `animateMoveToTarget`，指针向目标卡片中心飞行（持续约 350ms）。位移途中，卡片浮现微弱引力薄雾，提示视线正在靠近。

### 阶段 2：飞抵与空间锁定（T = 350ms ~ 500ms）
1. 鼠标精准飞抵卡片中心（此时 DOM 卡片已在阶段 1 抢占挂载完毕，零白屏、零错位）；
2. 聚焦系统正式将 `c1` 确立为 `primaryCardId`：卡片瞬间呈现 **2.5px 纯净紫描边**（`outline: #a45cf8`）并挂载微型 `[ Mira ]` 角标；
3. 若为 `ui.actAndObserve`，动作系统在此刻执行真实的物理下压（`isActive: true`）、点击涟漪或聚焦输入框。

### 阶段 3：工作与多源协同（T = 500ms ~ 生成结束）
1. 若为 `card.generate`（生图创作）：
   * 指针变幻为「星芒 ✨」；
   * 主卡片（`targetCardId`）进入柔和的 **0.8s 紫色能量呼吸脉冲**；
   * 关联的参考卡片（`referenceCardIds`）批量加入聚焦系统，呈现**紫色虚线高亮**；
2. 用户在界面上能瞬间直观理解：“Agent 鼠标停在主卡上，周围几张参考卡片连动发光，正在合成生成”。

### 阶段 3.5：基于工具输出的动作解析机制 (Output-Driven Action Resolution)
在生图与衍生卡片场景中，实体目标具有**生成不确定性**：
* **输入阶段（Input）**：Agent 大多传入 `targetCardId: "new"`，此时目标卡片尚未在物理坐标系中诞生，无法提前预知目标 ID 与屏幕世界坐标；
* **输出阶段（Output）**：卡片在画布数据层完成实例化后，`card.generate` 工具即刻输出标准结果 `{ success: true, cardId: "card_xxx", ... }`；
* **输出驱动解析契约 (The Contract)**：
  Runtime 工具执行管道必须配置「输出动作解析器 (Output-Driven Action Resolver)」：
  只要监测到工具产生有效输出（包含 `output.cardId`），无论底层是否处于异步排队、草稿还是提交中，系统必须**第一时间拦截 output 并将其解析为对应鼠标动作**：
  1. 提取 `output.cardId`；
  2. 立即将聚焦系统的 `primaryCardId` 指向新卡片，设定角色为 `working`；
  3. 0ms 无延迟调度 Agent 鼠标直飞新卡片（`animateMoveToTarget('canvas.card.' + cardId)`）；
  4. 在新卡片上完成真实的下压点击施法手势（`isActive: true` ➔ 180ms ➔ `isActive: false`）。

这保证了在用户视角中：**卡片只要在画布上生成的瞬间，Agent 鼠标必定在第一时间精准飞抵并锁定新卡片！**

### 阶段 4：动作交接与优雅释放（Handoff & Fade-out）
1. 工具执行完成，或任务转向下一个步骤：
   * 若 Agent 紧接着操作卡片 B，焦点瞬间平滑转移至卡片 B，原卡片立即释放；
   * 若任务结束（`sys.endTask`）或等待用户确认（`user.ask`）：
     * 指针恢复默认待机小箭头，漂浮回休息位；
     * 卡片上的紫色聚焦**保留 2.5 秒**（作为视觉锚点方便用户目光巡检），随后在 400ms 内优雅过渡淡出，不留任何永久脏状态。

---

## 4. 与边框分批加载机制（Progressive Mounting）的工程啮合

1. **抢占式优先挂载 (Preemption)**：
   * 现有的 `sortedPending` 根据距离中心和 `selectedCardIds` 排序；
   * 协同系统中：`isAgentFocused(c.id)` 拥有比用户选中更高的置顶权重，确保动作系统到达前 DOM 已经渲染就绪。
2. **NanoLodCanvas 底衬双保障**：
   * 在超低缩放（`< 0.60`）或 DOM 极端掉帧场景下，`NanoLodCanvas` 实时订阅 `AgentFocusManager.focusedMap`；
   * Canvas 负责立即在对应坐标绘制紫色外边框与角标，确保哪怕 DOM 未就绪，视觉聚焦**零延迟、零丢帧、百分之百在线**。

---

## 5. 架构合规性自查

* [x] **数据与 DOM 解耦**：聚焦系统仅维护 `Set<cardId>` 与纯元数据，不引用任何 DOM 节点；
* [x] **人机路径 1:1 对齐**：严格遵守《03-human-path-execution-contract.md》，必须先有工具和物理动作，后有页面聚焦事实；
* [x] **SSOT 确定性**：仅由 JSON 转译节点输出驱动，无自然语言幻觉风险。
