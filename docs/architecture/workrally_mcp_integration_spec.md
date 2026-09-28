# WorkRally MCP Integration & Media Generation Architecture Specification

This specification documents the complete architectural design, data flows, and reusable recipes of the **WorkRally Model Context Protocol (MCP) Integration** implemented in the Mira Canvas application. This system drives the high-fidelity, infinite-canvas AI image and video generation engine.

---

## 1. System Architecture Overview

The system utilizes a secure, decoupled three-tier architecture that guarantees both optimal performance (60fps canvas operations) and security for user tokens.

```
┌─────────────────────────────────────────────────────────────────┐
│                      Client View Layer                          │
│  ┌─────────────────────────┐       ┌─────────────────────────┐  │
│  │   GenerationCard.tsx    │       │    McpTokenModal.tsx    │  │
│  └────────────┬────────────┘       └────────────┬────────────┘  │
└───────────────┼─────────────────────────────────┼───────────────┘
                │ State/Actions                   │ Token Operations
┌───────────────▼─────────────────────────────────▼───────────────┐
│                    Client Logic & Storage                       │
│  ┌─────────────────────────┐       ┌─────────────────────────┐  │
│  │     useMcpKey.ts        │       │     mcpStorage.ts       │  │
│  │   (React State Hook)    │◄──────┼─►  (IndexedDB Storage)  │  │
│  └─────────────────────────┘       └─────────────────────────┘  │
└──────────────────────────────────────┬──────────────────────────┘
                                       │ Secure API Proxy Calls
┌──────────────────────────────────────▼──────────────────────────┐
│                   Express Backend Proxy Layer                   │
│                    (server.ts -> mcpRouter.ts)                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                  mcpRouter Endpoint (/api)                 │  │
│  │  - /test: Handshake latency & Tool discovery              │  │
│  │  - /models: Dynamic capabilities extraction              │  │
│  │  - /generate: Intelligent orchestration & mapping         │  │
│  │  - /task: Async task polling & URL resolution             │  │
│  └─────────────────────────────┬─────────────────────────────┘  │
└────────────────────────────────┼────────────────────────────────┘
                                 │ Standard JSON-RPC Over HTTP
┌────────────────────────────────▼────────────────────────────────┐
│                   WorkRally External Services                   │
│  ┌─────────────────────────┐       ┌─────────────────────────┐  │
│  │  Tencent Cloud COS SDK  │       │   WorkRally MCP Server  │  │
│  │   (Binary asset uploads)│       │   (Image/Video Gen Engine)│  │
│  └─────────────────────────┘       └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Token Security & Storage Architecture (`mcpStorage.ts`)

To adhere to the **Data-DOM Decoupling Principle** and provide maximum security, user tokens are **never stored in the DOM** or exposed to browser telemetry.

### Key Highlights:
*   **IndexedDB Native Store (`mira_mcp_config_db`)**: Keeps tokens locally encrypted inside the user's browser sandbox.
*   **Decoupled Hook (`useMcpKey`)**: Restricts access to functional state, completely isolating credentials from DOM rendering trees.
*   **Multi-Credential Support**: Supports saving, editing, and instantly swapping between multiple active keys.

### Storage Schema Mapping (`McpKeyItem`):
```typescript
export interface McpKeyItem {
  id: string;               // Unique primary key
  name: string;             // Label/Name chosen by user
  token: string;            // Bearer credential token
  serverUrl: string;        // End-point (Default: https://workrally.qq.com/zenstudio/api/mcp)
  createdAt: number;
  lastUsedAt?: number;
  lastTestedAt?: number;
  lastTestStatus?: 'success' | 'failed';
  lastTestMessage?: string;
  discoveredTools?: string[]; // Dynamic capability listing cache
  isActive: boolean;        // Toggle identifying the active system-wide key
}
```

---

## 3. Server-Side MCP Proxy Implementation (`mcpRouter.ts`)

The Express backend proxy handles complex JSON-RPC standard handshakes, binary asset uploads to Tencent Cloud COS, CDN redirections, and multi-stage task polling. This protects the frontend from CORS blocks and network timeouts.

### 3.1 Live Credentials Validation (`/api/mcp/workrally/test`)
Exposes endpoint to test credentials. It measures round-trip latency and fetches registered tools in a single sweep:
1.  Initiates standard MCP **`initialize`** request.
2.  Dispatches **`tools/list`** to inspect the server’s active catalog.
3.  Returns raw registered capabilities and operational details to the client UI.

### 3.2 Dynamic Tool Capability Engine (`/api/mcp/workrally/models`)
Avoids hardcoded schemas. It polls **`tools/list`** and extracts the exact input definitions (ratios, resolutions, parameters) allowed by the active generation models. It automatically classifies:
*   **`pickGenerationTool`**: Discovers the best-performing Image Generation (e.g., `t2i`, `draw`, `图片生成`) or Video Generation (e.g., `t2v`, `i2v`, `视频生成`) tools using heuristic text mapping and input schema parameters.
*   **`pickModelListTool`**: Searches for auxiliary tools registered to fetch model identifiers (e.g., `model_list`, `available_models`).

### 3.3 Reference Image Upload Architecture (Tencent COS Integration)
Image models depend on loss-free reference images. Standard web `data:` URIs or local blobs cannot be parsed directly by external generation endpoints. The router automates this binary bridging:

```
[Local Reference Image Base64] ──► [Server-Side parseImageDataUrl]
                                         │
┌────────────────────────────────────────▼───────────────────────┐
│ 1. Request WorkRally upload token:                             │
│    method: "tools/call", name: "get_upload_token"              │
└────────────────────────────────────────┬───────────────────────┘
                                         │ returns COS secret keys & bucket
┌────────────────────────────────────────▼───────────────────────┐
│ 2. Instantiate COS Node SDK and upload raw buffer:             │
│    cos.putObject(Bucket, Region, Key, Body)                    │
└────────────────────────────────────────┬───────────────────────┘
                                         │ success returns CDN location
┌────────────────────────────────────────▼───────────────────────┐
│ 3. Normalize to WorkRally authorized CDN Host                  │
│    (e.g. zenvideo-pro.gtimg.com)                               │
└────────────────────────────────────────┬───────────────────────┘
                                         ▼
                 [Standardized gtimg.com Media URL]
```

### 3.4 Asynchronous Task Polling and Short-Lived URL Resolution
Image/Video generations in WorkRally are asynchronous long-running jobs. 
*   **Task Submissions**: Successful calls yield a collection of `task_ids`.
*   **State Polling (`pollCanvasTask`)**: The router polls **`canvas_get_task`** at a 3-second interval (up to a 10-minute timeout for videos).
*   **Redirect Resolution**: WorkRally often returns short-lived, authenticated share URLs (`https://workrally.qq.com/s/`). The router intercepts these redirects server-side via `resolveWorkRallyShareUrl`, pulling the signed, absolute Tencent CDN media target and passing it safely to the browser.

---

## 4. Frontend Media Generation Interface (`GenerationCard.tsx`)

Each image or video asset on the infinite canvas is modeled as an isolated card. The card seamlessly shifts through multiple states while keeping the drag-and-zoom environment fluid.

### 4.1 Card Lifecycle States:
*   `draft`: Configuration mode where the user modifies prompts, models, ratios, and attaches reference images.
*   `generating`: Submission phase where the UI locks controls, shows a rolling shimmer, and actively monitors backend progress.
*   `completed`: Success state. The card loads its high-performance canvas component, caching the generated media locally.

### 4.2 Decoupled Parameter Mapping:
When the user clicks "生成", the card aggregates parameters into a clean, serializable object to submit to `/api/mcp/workrally/generate`:
```typescript
const payload = {
  prompt: cardData.prompt,
  ratio: cardData.ratio,            // e.g. "16:9", "1:1", "9:16"
  res: cardData.resolution,         // e.g. "1K", "2K", "4K"
  isVideo: cardData.isVideo,        // Toggle for video vs image engine
  referenceImages: cardData.referenceImages, // Array of reference asset references
  model: cardData.selectedMcpModel?.id,
  toolName: cardData.selectedMcpTool,
  parameters: cardData.parameters,  // Dynamic model-specific settings
  defer: true                       // Yield task ID immediately to allow card-level async polling
};
```

---

## 5. UI Setup & Connection Test Component (`McpTokenModal.tsx`)

The credentials drawer is the central portal for testing connection stability and analyzing server-side tools.

### Operational Features:
1.  **Immediate Feedback**: Displays round-trip handshake latency in milliseconds.
2.  **Tool Discovery Matrix**: Discovered tools are rendered in real-time as clickable badges, providing hovering insights into the underlying JSON-schema definitions.
3.  **Active Switcher Pills**: Allows instant selection of the active profile.

---

## 6. One-Shot Reusability Recipes (Cheat-Sheet)

Follow these direct steps to instantly port, mount, and run this system on any standard Node.js/React project:

### Step 1: Install Package Dependencies
Make sure you have the Tencent COS Node SDK installed in your project:
```bash
npm install cos-nodejs-sdk-v5
```

### Step 2: Register Endpoints in Express App (`server.ts`)
Mount the MCP router proxy in your main Express app entry point:
```typescript
import { mcpRouter } from './src/server/mcpRouter';

// Mount under standard api namespace
app.use('/api/mcp/workrally', mcpRouter);
```

### Step 3: Configure Environment Variables (`.env.example`)
Ensure the default endpoint URL is configured or documented:
```env
# Optional overriding endpoint for WorkRally MCP Server
VITE_WORKRALLY_MCP_URL=https://workrally.qq.com/zenstudio/api/mcp
```

### Step 4: Rapid Validation Script
Run this curl snippet to instantly verify your backend proxy is active and communicating:
```bash
curl -X POST http://localhost:3000/api/mcp/workrally/test \
  -H "Content-Type: application/json" \
  -d '{"token": "your_workrally_token_here"}'
```

---

## 7. Performance Safeguards in the Canvas Layout

To guarantee that the multi-stage rendering and polling inside card clusters never degrade the Infinite Canvas performance, the following rules are strictly enforced:
1.  **Intent-Driven Lazy Restoration**: Running animation timers or active panning events temporarily strip intensive shadow/blur filters.
2.  **LOD-Triggered Lazy Mounting**: When zooming out below the LOD threshold, heavy canvas rendering trees are unmounted and replaced by efficient Canvas-based static representations (`NanoLodCanvas.tsx`).
3.  **Decoupled Selection States**: Selection tracking arrays (`selectedCardIds`) are isolated using React Refs (`selectedCardIdsRef`) during viewport culling passes, ensuring that selecting/unselecting cards never triggers cascading re-renders across unaffected nodes.
