# 视频播放器重构规范与架构设计 (Video Player Architecture Refactoring Spec)

本文档记录了无限画布场景下，视频卡片播放器架构重构的设计方案与代码模块划分标准。

## 一、 重构目标与核心痛点

1. **消除代码膨胀**：原 `GenerationCard.tsx` 体量达 3400+ 行，集成了 UI、生图、MCP 轮询、视频播放与 DOM 事件。通过剥离视频播放器，显著提升维护性。
2. **彻底解耦数据与 DOM**：消除 `App.tsx` 中直接操作 DOM（如 `document.querySelectorAll('video')`）的反模式，建立统一的 `VideoRegistryService`。
3. **0 秒进度防擦除与手势同步**：
   - 使用 W3C `#t=timestamp` 媒体片段实现挂载时 0 延迟秒级定位。
   - 在用户点击手势内同步触发 `video.play()`，100% 绕过 Chrome Autoplay 拦截。
   - 加入 `0s` 挂载过滤防护，防止未初始化/卸载瞬间将 `0` 写入存储覆盖掉有效播放进度。

---

## 二、 核心架构设计与模块划分

```text
src/
├── services/
│   └── videoRegistry.ts          # 全局视频实例注册表（替代 DOM querySelector）
├── hooks/
│   └── useVideoPlayer.ts         # 视频播放核心 Hook（状态、进度防擦除、播放/暂停、Media Fragment）
├── components/
│   └── video/
│       ├── VideoControlOverlay.tsx # 视频控制器浮层（播放/暂停/进度条/时间戳）
│       └── VideoCardPlayer.tsx     # 视频播放器主组件（懒挂载、LOD 与事件绑定）
└── utils/
    └── mediaUrlResolver.ts       # 媒体 URL 解析与代理转换工具
```

---

## 三、 模块详细规范

### 1. 全局视频注册表 `services/videoRegistry.ts`
管理画布上所有活态视频卡片的 DOM 引用与手势暂停/恢复机制：
- `register(cardId, element)`
- `unregister(cardId)`
- `pauseAllForGesture()`
- `resumeAllAfterGesture()`

### 2. 视频核心 Hook `hooks/useVideoPlayer.ts`
- 结合 `localStorage` 与 `CardData` 缓存恢复播放位置。
- 自动拼接 `#t=timestamp` 媒体片段。
- 拦截并防止未卡接状态下 `0s` 擦除历史进度的行为。
- 同步在手势点击上下文中触发 `play()` 与音量解禁。

### 3. 视频控制器浮层 `components/video/VideoControlOverlay.tsx`
- 呈现中央播放/暂停按钮。
- 呈现底部悬浮播放控制条（播放/暂停图标、Seek Range 拖动条、`currentTime / duration` 时间格式化显示）。

### 4. 视频播放器组件 `components/video/VideoCardPlayer.tsx`
- 实现根据 `isHovered` 或 `isPlaying` 的意图驱动懒挂载 (Lazy Mounting)。
- 集成视频流加载错误与代理自愈逻辑。
