# 无限画布媒体资产导入架构规范 (Asset Import Architecture Specification)

## 1. 概述 (Overview)

在包含大量高清图片与视频的无限画布 (Infinite Canvas) 场景中，媒体资产的导入是用户交互的第一入口，也是对系统响应速度、GPU 栅格化开销与主线程流畅度要求极高的核心环节。

本规范完整记录了系统中**全渠道媒体资产导入机制（本地拖拽、剪贴板粘贴、剧本/节点资产提取）**的整体架构、数据流向、GPU 硬件加速处理管线、多级 LOD 金字塔生成以及无感渲染保障策略。

### 核心设计原则
1. **主线程零阻塞 (60fps Non-Blocking)**：批处理导入过程中，通过异步线程让出 (`yieldToMain`) 保证拖拽、缩放与 UI 渲染维持 60fps 极限阻尼手感，彻底消除 Micro-Jank。
2. **数据与 DOM 深度解耦 (Data-DOM Decoupling)**：视图层（UI/Canvas）仅渲染轻量级代理 Blob 与多级 LOD 纹理；业务层数据模型 (`CardData`) 始终保存 100% 完整无损的原始二进制数据 (`trueOriginalFileData`)。
3. **GPU 硬件加速重绘 (WebGL Offscreen Processing)**：利用 OffscreenCanvas / WebGL 管线在显存中完成超大原图（4K/8K）的重采样与压缩，降低 CPU 内存开销。
4. **多级 LOD 离屏预生成 (Multi-LOD Pyramids)**：导入阶段即完成 Micro-LOD (128px)、Full-LOD (1200px) 及 Closeup (2048px/4K) 金字塔纹理的生成与纹理预热。
5. **入场动画与无感交接 (Seamless Intent-Driven Handoff)**：利用草稿占位节点 (Draft/Generating State)、锁定入场动画 (`holdCardsAtEntryStart`) 与双层 Cross-Fade 纹理垫底机制，实现从导入瞬间到视角平移缩放的全程零闪烁。

---

## 2. 触发入口与坐标映射 (Import Entry Points & Canvas Coordinate Mapping)

媒体资产可从多种入口导入，系统统一将其转换为标准世界坐标系下的卡片节点。

```
 +------------------+     +-------------------+     +------------------------+
 | 本地文件拖拽     |     | 剪贴板粘贴        |     | 剧本/节点资产提取      |
 | (handleDrop)     |     | (handlePaste)     |     | (Extract & Batch)      |
 +--------+---------+     +---------+---------+     +-----------+------------+
          |                         |                         |
          +-------------------------+-------------------------+
                                    |
                                    v
                     [ 视口 -> 世界坐标 映射换算 ]
                       worldX = (clientX - tx) / scale
                       worldY = (clientY - ty) / scale
                                    |
                                    v
                      [ importFilesToCanvas 主控 ]
```

### 2.1 拖拽导入 (`handleDrop`)
- **事件捕获**：解析 `DataTransferItem` 与 `FileList`，提取图片 (`image/*`) 和视频 (`video/*`) 文件。
- **坐标映射**：获取拖拽落点的 DOM 屏幕坐标 `(dropClientX, dropClientY)`，通过当前无限画布视口变换矩阵反算为画布绝对世界坐标：
  $$\text{worldX} = \frac{\text{dropClientX} - \text{tx}}{\text{scale}}$$
  $$\text{worldY} = \frac{\text{dropClientY} - \text{ty}}{\text{scale}}$$

### 2.2 粘贴导入 (`handlePaste`)
- **多类型解析**：
  1. **File 对象**：系统剪贴板直接复制的图片/视频文件。
  2. **Data URI (`data:image/...`)**：自动解码 Base64 并转换为二进制 Blob，防止内存泄漏。
  3. **网页图片 URL**：通过 Fetch / Proxy 提取远程图片跨域 Blob。
- **排布逻辑**：若无具体鼠标焦点，默认将导入资产平铺于当前视口中央，或沿当前选中节点的右侧呈列队排布。

---

## 3. 导入生命周期与状态机 (Import Lifecycle & State Machine)

为保证用户在点击或拖入的 **0 毫秒** 内获得明确的视觉反馈，导入流程采用“草稿占位 $\rightarrow$ 异步后台处理 $\rightarrow$ 纹理就绪落地”的三阶段生命周期。

```
  [ 导入触发 ]
       |
       v  (0ms 瞬间)
 +-------------------------------------------------------------------+
 | 1. 创立草稿卡片 (Draft/Generating State)                          |
 |    - 在画布生成高亮草稿外框                                       |
 |    - 标注 isImporting: true / "正在导入..."                       |
 |    - 锁入 1.38 倍悬浮入场姿态 (holdCardsAtEntryStart)              |
 +-------------------------------------------------------------------+
       |
       v  (异步并发处理，线程让出 yieldToMain)
 +-------------------------------------------------------------------+
 | 2. GPU 重采样与 Multi-LOD 金字塔构建                              |
 |    - WebGL 离屏生成 1200px 高清代理 Blob                         |
 |    - 离屏 Canvas 生成 128px Micro-LOD 缩略图                      |
 |    - 提取 Video Poster 第 0.1 秒帧封面                          |
 |    - GPU Texture 纹理预热 (preloadAndDecodeImage)                |
 +-------------------------------------------------------------------+
       |
       v  (处理完成)
 +-------------------------------------------------------------------+
 | 3. 动画解锁与落地 (Card Entrance Drop)                            |
 |    - 绑定真实 LOD Blob 与原始二进制 trueOriginalFileData          |
 |    - 触发 triggerCardDrop 执行平滑落板动画                        |
 |    - 捕获 card-entrance-complete，清除草稿标记                    |
 +-------------------------------------------------------------------+
```

### 3.1 草稿占位节点与“正在导入”反馈
- 当文件解析开始时，系统先向状态层添加带有 `isImporting: true` 和 `isGenerating: true` 的占位节点。
- UI 卡片检测到 `isImporting` 状态时，会渲染精美的半透明磨砂面板与“正在导入...”脉冲加载指示器，避免用户误以为页面无响应。

### 3.2 入场锁定与落地通知 (`cardEntrance.ts`)
- **悬浮锁 (`holdCardsAtEntryStart`)**：新建节点初始渲染时被锁定在 1.38 倍放大缩放视角与高亮外发光状态。
- **落地动画 (`triggerCardDrop`)**：当后台 GPU 重采样与 LOD 金字塔创建完毕后，解锁该卡片并施加弹簧阻尼降落动画。
- **完成回调**：监听 `card-entrance-complete` 事件，彻底清除卡片的临时导入标记，将其归入四叉树 (`quadTree.ts`) 空间索引中。

### 3.3 异步线程让出机制 (`yieldToMain`)
为了防止一次性拖入 20+ 张 4K 高清大图时主线程被图片 Seek / Canvas Draw 堵死，批处理循环在处理每一张媒体前均会调用 `yieldToMain()`：
```typescript
export async function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      setTimeout(resolve, 0);
    });
  });
}
```
该机制将图像重采样拆解为微任务切片，确保用户在导入大量文件时，画布的拖拽、平移与缩放依然能稳定运行在 60fps。

---

## 4. GPU 加速与 Multi-LOD 图像金字塔 (GPU-Accelerated Multi-LOD Processing)

为了兼顾“长距离鸟瞰场景下的超轻量渲染”与“近距离观察时的像素级细节”，导入阶段会为每张图片/视频建立 Multi-LOD 图像金字塔。

```
                             [ 原始二进制文件 ]
                       (Original Data / 4K/8K File)
                                    |
                 +------------------+------------------+
                 |                                     |
                 v                                     v
     [ GPU/WebGL 硬件重采样 ]              [ 离屏 Canvas 金字塔构建 ]
    (gpuImageProcessor.ts)                    (thumbnail.ts)
                 |                                     |
                 v                                     v
       +--------------------+                +--------------------+
       | 1200px Full LOD    |                | 128px Micro LOD    |
       | 高清代理 Blob      |                | 极轻量缩略图       |
       +--------------------+                +--------------------+
                 |                                     |
                 +------------------+------------------+
                                    |
                                    v
                        [ 显存纹理预热 & 缓存 ]
                      (preloadAndDecodeImage)
```

### 4.1 WebGL 离屏管线 (`gpuImageProcessor.ts`)
对于超高分辨率图片（宽度或高度 $> 4096\text{px}$），直接用 Canvas2D 调整尺寸会导致严重的主线程卡顿与内存爆表。系统优先调用 WebGL 离屏重采样管线：
- **GPU 纹理上传**：将原始 `HTMLImageElement` / `ImageBitmap` 直接上传至 GPU 显存。
- **硬件双线性/三线性插值**：利用 WebGL 硬件着色器高效完成降采样。
- **导出 WebP/JPEG 代理 Blob**：生成最大边长为 1200px 的代理图片 Blob（文件体积通常仅 100KB-300KB），作为默认视角下的无损高清替代品。

### 4.2 Multi-LOD 金字塔层级划分
1. **Micro-LOD (128px)**：
   - 当视口缩放比例 $< 30\%$ (Nano LOD 模式) 时使用。
   - 内存占用极为微小（通常 $< 5\text{KB}$/张），极大地缓解超大画布上成百上千张卡片同时渲染时的 GPU 栅格化负担。
2. **Full-detail LOD (1200px)**：
   - 标准画布视图（$30\% - 200\%$ 缩放比）下的主力渲染纹理。
3. **Closeup / Ultra LOD (2048px/4K)**：
   - 当用户放大视口超过 $200\%$ 并聚焦于当前卡片中心时，自动按需挂载近距离高清纹理。
4. **Video Poster 视频首帧封面**：
   - 视频文件导入时，利用 `<video>` + 离屏 `<canvas>` 快速提取 $t = 0.1\text{s}$ 处的帧快照作为 Poster 封面图，避免后台常驻 `<video>` 节点消耗 GPU 合成层。

### 4.3 显存纹理预热与解码 (`preloadAndDecodeImage`)
在将 LOD 代理图片 URL 赋给 React DOM/Canvas 节点前，调用 `ImageDecoder` 或 `HTMLImageElement.decode()` 完成离屏预解码：
- 确保图片在挂载到 DOM 的瞬间，GPU 显存中已存在解码完毕的纹理，实现**挂载即贴图，绝不白屏**。

---

## 5. 数据与 DOM 深度解耦 (Data-DOM Decoupling & Pure Data Flow)

遵循系统 core 规则，业务数据与 DOM 视图保持 100% 解耦。

```
+-----------------------------------------------------------------------+
|                            CardData 模型                              |
|                                                                       |
|  [ 视图渲染字段 (Light Proxy) ]     [ 核心业务/AI 字段 (Lossless Original) ] |
|  - displayUrl: LOD 代理 Blob URL   - trueOriginalFileData: ArrayBuffer|
|  - microLodUrl: 128px 缩略图 Blob   - originalFileName: "raw_4k.png"   |
|  - aspectRatio: 1.778              - mimeType: "image/png"            |
+-----------------------------------+-----------------------------------+
                  |                                   |
                  v                                   v
         +-----------------+                 +-----------------+
         | UI / DOM / Canvas |                 | AI 多模态模型 / |
         |  (轻量无卡顿渲染)  |                 | 导出 / 质检引擎 |
         +-----------------+                 +-----------------+
```

- **渲染层**：仅感知 `displayUrl` 与 `microLodUrl`，只处理轻量化的代理图片/视频封面。
- **AI 业务层**：当用户对卡片发起 AI 生图、垫图参考（Image-to-Image）、视频扩展或长文本解析时，系统跳过 UI 渲染代理，直接从 `CardData.trueOriginalFileData` 提取最原始、未经过任何压缩与裁剪的二进制流，保证发送给 AI 大模型的输入数据 **100% 零损**。

---

## 6. LOD 切换与无感渲染保障 (Seamless LOD Transition & Visual Stability)

为了解决视口从超小比例（Nano LOD）平滑放大到大比例（Full LOD）时图片因 DOM 重新加载产生的闪烁问题，系统实现了专门的 **LOD 无感交接策略 (`lodHandoff.ts` & `cardLodAppearance.ts`)**。

### 6.1 闪烁根因分析
在过去的传统实现中，当缩放比例跨越阈值（如从 $0.29$ 到 $0.31$）时，卡片组件会直接将 `<img>` 的 `src` 从 `microLodUrl` 替换为 `displayUrl`。即使图片已在内存缓存中，浏览器 DOM 在更换 `src` 瞬间仍会触发一次隐式重排 (Reflow) 与帧清空，导致卡片闪烁 1-2 帧白屏。

### 6.2 双层 Cross-Fade 无感交接机制
现在的无感交接架构策略如下：

```
                    [ 视口触发 LOD 级切换 (Nano -> Full) ]
                                      |
                                      v
            +---------------------------------------------------+
            | 1. 旧 LOD 纹理 (Micro LOD) 强制置底并保持 100% 透明度 |
            +---------------------------------------------------+
                                      |
                                      v
            +---------------------------------------------------+
            | 2. 新 LOD 纹理 (Full LOD) 在上层离屏预热 decode()   |
            +---------------------------------------------------+
                                      |
                                      v
            +---------------------------------------------------+
            | 3. 新纹理就绪后，通过 opacity 0 -> 1 双帧平滑淡入     |
            |    (0ms 即时干贴 / 150ms 交叉过渡)                   |
            +---------------------------------------------------+
                                      |
                                      v
            +---------------------------------------------------+
            | 4. 交接完毕后，安全回收旧纹理资源                    |
            +---------------------------------------------------+
```

1. **底层纹理垫底 (Old Texture Underlay)**：在切换过程中，原有的 Micro-LOD 图像继续保留在底层 Canvas/DOM 中，确保卡片内容始终可见。
2. **上层离屏预加载 (Offscreen Warm-Up)**：新级别的 Full-LOD / Closeup 纹理在离屏 Canvas 或 `imageTextureCache` 中完成 `decode()` 解码。
3. **交叉淡入/即时干贴**：当新纹理宣告就绪后，上层图像透明度平滑过渡至 1.0，底层旧纹理隐藏。全程无任何空档期，消除闪烁。

---

## 7. 模块关系与关键代码路径 (Module Relationships & Code References)

| 模块 / 文件 | 核心职责 |
| :--- | :--- |
| `src/App.tsx` | 监听 `handleDrop` 与 `handlePaste`，执行 `importFilesToCanvas`，完成视口世界坐标换算与批处理主控。 |
| `src/utils/gpuImageProcessor.ts` | 提供 WebGL 离屏重采样能力 (`gpuResizeImage`, `compressAndResizeImage`)，生成 1200px 高清代理图。 |
| `src/utils/thumbnail.ts` | 离屏 Canvas 生成 128px Micro-LOD 缩略图与视频第 0.1 秒 Poster 封面图 (`generateMultiLodThumbnails`)。 |
| `src/utils/cardEntrance.ts` | 管理草稿卡片的入场锁定 (`holdCardsAtEntryStart`) 与落地弹簧动画 (`triggerCardDrop`)。 |
| `src/utils/imageTextureCache.ts` | 提供离屏解码与 GPU 纹理预热缓存 (`preloadAndDecodeImage`)。 |
| `src/utils/lodHandoff.ts` & `src/utils/cardLodAppearance.ts` | 管理 LOD 跨越级切换时的双层垫底与无感 Cross-Fade 渲染。 |
| `src/db.ts` & `src/utils/mcpStorage.ts` | IndexedDB Worker 增量持久化存储，异步写入原图二进制与 LOD 代理 Blob。 |

---

## 8. 总结 (Conclusion)

通过**全渠道坐标精准映射**、**三阶段草稿与“正在导入”反馈**、**GPU 离屏重采样与 Multi-LOD 金字塔**、**数据与 DOM 深度解耦**以及 **LOD 切换双层无感 Hand-off 机制**，系统构建了一套兼具高响应度、零闪烁与极致性能的无限画布媒体资产导入管线，确保了在巨量媒体卡片下的 60fps 稳定手感。
