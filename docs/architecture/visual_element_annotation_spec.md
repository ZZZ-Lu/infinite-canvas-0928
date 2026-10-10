# 画面元素标注节点架构设计与交互规范 (Visual Element Annotation Spec)

## 1. 概述与设计理念

「画面元素标注节点」是画布系统与 Mira Agent 的原生多模态视觉空间定位与语义解析引擎。与传统的固定人体解剖扫描不同，该节点遵循**意图驱动（Intent-Driven）**、**数量自适应（Dynamic Count）**与**全生命周期 CRUD（增删查改）**的设计标准。

### 核心设计原则：
1. **意图驱动 (Intent-Driven)**：Agent 或人类用户调用该节点时，**必须显式传入具体的标注要求**（`requirement` 或 `prompt`）。系统不再预设或强加死板的人体解剖部位，一切标注均围绕具体任务目标（如：“标注持剑姿态与武器细节”、“标出画面主光源与影子投射位置”、“找出背景中的三座古建筑”）展开。
2. **去硬编码与无数量限制 (Unconstrained Visual Grounding)**：节点 Prompt 彻底解绑身体部位名单（眼睛、颈项、胸部、手等），移除固定的“3~8个”数量截断。按需定位 1 个主体、10 个环境道具，或在画面无匹配元素时如实返回空列表。
3. **数据增删查改 (CRUD Lifecycle)**：标注产物不仅是一次性的识别结果，更是画布卡片上的结构化资产。支持追加合并 (`append`)、覆写更新 (`overwrite`)、单项修改、按 ID 删除与全量清空。
4. **数据与 DOM 彻底解耦 (Data-DOM Decoupling)**：所有元素标注数据均作为纯数据对象存储在卡片数据模型中，规范化为世界百分比坐标（0~100%），100% 可序列化（支持 `JSON.stringify`），不依赖任何 DOM 或宿主环境。

---

## 2. 元素标注数据模型 (Data Schema)

```ts
export interface VisualElementAnnotation {
  id: string;                             // 元素全局唯一 ID，例如 "elem_x9f2"
  label: string;                          // 语义标签，例如 "唐横刀", "远景双月", "主光源"
  category?: string;                      // 元素类别，例如 "prop", "character", "environment", "lighting"
  point: { x: number; y: number };        // 核心锚点 / 视觉重心（百分比 0~100%）
  box?: [number, number, number, number]; // 2D 包围盒 [ymin, xmin, ymax, xmax]（百分比 0~100%）
  description?: string;                   // 视觉特征或细节描述
  importance?: number;                    // 视觉重要度权重（0.1 ~ 1.0）
  source?: 'ai_detected' | 'user_created' | 'agent_updated'; // 数据来源
  createdAt?: number;                     // 标注时间戳
}

export interface SubjectLandmarks {
  detectedAt: number;
  requirement?: string;                   // 本次识别所依据的标注要求/指令
  summary?: string;                       // 标注总结简述
  elements?: VisualElementAnnotation[];   // 规范化的画面元素标注列表
  modelUsed?: string;                     // 调用的多模态模型
  fallbackNotice?: string;
  // 向下兼容历史字段
  interestPoints?: InterestPoint[];
  regions?: Record<string, any>;
}
```

---

## 3. Agent 工具协议与调用规范 (Agent Tool Protocol)

- **工具名称**：`card.detectLandmarks`（别名：`card.annotateElements`）
- **操作动作 (`action`)**：
  - `detect`（默认）：调用视觉大模型执行元素定位与识别。**必须提供 `requirement`**。
    - `mode: 'append'`：在卡片现有标注基础上追加新增元素；
    - `mode: 'overwrite'`：完全覆写现有标注。
  - `list`：读取卡片当前的全部元素标注列表。
  - `update`：根据传入的 `updates` 数组更新已有元素的标签、描述或坐标。
  - `delete`：根据 `deleteIds` 数组删除指定元素。
  - `clear`：清空卡片的全部标注数据。

### 工具输入 Schema：
```json
{
  "cardId": "string (必填)",
  "action": "detect | list | update | delete | clear (可选，默认 detect)",
  "requirement": "string (当 action 为 detect 时必填，如：'标注人物手中折扇与腰间配玉')",
  "mode": "append | overwrite (可选，默认 overwrite)",
  "updates": [
    {
      "id": "elem_1",
      "label": "修罗玉佩",
      "description": "青碧色双龙戏珠环佩"
    }
  ],
  "deleteIds": ["elem_2"],
  "force": true
}
```

---

## 4. Prompt 与模型交互规范

### System Prompt 规范：
- 模型定位为**原生多模态视觉元素定位与语义解析专家**。
- 严格遵循用户传入的 `【标注要求】` 进行原生 Visual Grounding 提取。
- 统一输出 `box_2d: [ymin, xmin, ymax, xmax]`（0~1000 整数坐标）。
- 如果画面中未发现符合要求的元素，模型在 `summary` 中如实说明并返回空 `elements` 数组，杜绝强行幻觉。

---

## 5. UI 与 HUD 交互规范

- **HUD 显示**：在卡片浮动工具栏提供「元素标注」开关。
- **锚点与包围盒**：以优雅高对比度的彩色半透明标签和光点锚定在画面上。
- **交互操作**：用户点击标注标签可展开查看详细描述、支持点击删除按钮一键移除该标注，也可在卡片上直接增添标注。
