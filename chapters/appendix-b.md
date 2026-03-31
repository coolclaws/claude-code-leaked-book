# 附录 B：核心类型速查

Claude Code 的 TypeScript 代码库中定义了大量接口和类型，它们构成了系统的骨架。本附录提取了最重要的 18 个类型定义，以速查表的形式呈现其文件位置、关键字段和使用场景，方便读者在阅读正文时随时查阅。

---

## 一、工具系统类型

### 1. Tool

```typescript
// src/Tool.ts:362-504
interface Tool {
  name: string
  description: string
  inputSchema: JSONSchema
  isEnabled: (context: ToolUseContext) => boolean
  call: (input: unknown, context: ToolUseContext) => Promise<ToolResult>
  checkPermissions: (input: unknown, context: ToolPermissionContext) => PermissionResult
  userFacingName: (input: unknown) => string
  isReadOnly: () => boolean
  // ... 其他可选方法
}
```

`Tool` 是整个工具系统的核心接口，每个内置工具和 MCP 工具都必须实现它。`call` 方法执行实际操作，`checkPermissions` 在执行前进行权限拦截，`inputSchema` 提供 JSON Schema 供 LLM 生成合法参数。该接口在第 7 章有详细剖析。

### 2. ToolResult\<T\>

```typescript
// src/Tool.ts:321-336
interface ToolResult<T = unknown> {
  data: T
  newMessages?: Message[]
  contextModifier?: (context: ToolUseContext) => ToolUseContext
}
```

工具执行的返回值。`data` 是工具产出的原始数据；`newMessages` 允许工具向对话历史注入额外消息；`contextModifier` 可以修改后续工具调用的上下文——这是一种强大的副作用传播机制。

### 3. ToolUseContext

```typescript
// src/Tool.ts:158-300
interface ToolUseContext {
  abortController: AbortController
  options: QueryEngineConfig
  readFileTimestamps: Map<string, number>
  currentWorkingDirectory: string
  tools: Tool[]
  mcpConnections: MCPServerConnection[]
  // ... 约 30 个字段
}
```

传递给每次工具调用的上下文对象，是工具系统中最"胖"的接口。它携带了当前工作目录、可用工具列表、MCP 连接、文件时间戳缓存等几乎所有运行时信息。设计上采用了"大上下文对象"模式，避免了多参数传递的复杂性，但也意味着工具可以访问大量全局状态。

### 4. ToolPermissionContext

```typescript
// src/Tool.ts:123-138
interface ToolPermissionContext {
  tool: Tool
  input: unknown
  permissionMode: PermissionMode
  workingDirectory: string
  allowedPaths: string[]
  deniedPatterns: RegExp[]
}
```

权限检查的精简上下文，仅包含判定权限所需的最小信息集。与 `ToolUseContext` 分离是有意为之——权限检查不应依赖执行上下文中的可变状态。

---

## 二、状态管理类型

### 5. AppState

```typescript
// src/state/AppStateStore.ts:89-158
type AppState = DeepImmutable<{
  messages: Message[]
  isLoading: boolean
  currentTask: TaskStateBase | null
  permissionMode: PermissionMode
  tools: Tool[]
  // ... 约 20 个字段
}>
```

应用全局状态的顶层类型。通过 `DeepImmutable` 包装，确保状态在任何层级都不可被直接修改，只能通过 `setState` 产生新状态。这一设计借鉴了 Redux 的不可变状态理念，但实现更为轻量。

### 6. Store\<T\>

```typescript
// src/state/store.ts:4-8
interface Store<T> {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: (state: T) => void) => () => void
}
```

通用状态容器接口，仅三个方法。`setState` 接受更新函数而非直接值，保证了状态变更的原子性。`subscribe` 返回取消订阅函数，遵循了 React 生态中常见的清理模式。整个状态系统没有引入 Redux、MobX 等外部依赖，完全自研。

---

## 三、查询引擎类型

### 7. QueryEngineConfig

```typescript
// src/QueryEngine.ts:130-173
interface QueryEngineConfig {
  model: string
  maxTokens: number
  systemPrompt: string
  tools: Tool[]
  temperature?: number
  promptCacheEnabled: boolean
  // ... 约 15 个字段
}
```

Query Engine 的配置接口，决定了每次 LLM 调用的行为参数。`promptCacheEnabled` 控制是否启用 Anthropic API 的 Prompt Cache 特性，可显著降低重复 prompt 前缀的计算成本。

### 8. QueryEngine

```typescript
// src/QueryEngine.ts:184
class QueryEngine {
  constructor(config: QueryEngineConfig)
  query(messages: Message[]): AsyncGenerator<StreamEvent>
  // ...
}
```

系统核心类，封装了与 LLM 的完整交互循环。`query` 方法返回异步生成器，通过 `yield` 逐步产出流式事件（文本片段、工具调用请求等），调用方可以实时消费这些事件来更新 UI。

---

## 四、任务系统类型

### 9. TaskType

```typescript
// src/Task.ts:6-13
type TaskType = "main" | "agent" | "coordinator" | "worker"
```

四种任务类型的联合类型。`main` 是用户直接发起的主任务；`agent` 是通过 Agent Tool 创建的子任务；`coordinator` 和 `worker` 构成 Coordinator Mode 下的多 Agent 协作模型。

### 10. TaskStatus

```typescript
// src/Task.ts:15-20
type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled"
```

任务生命周期的五种状态。状态转换是单向的：`pending -> running -> completed/failed/cancelled`，不允许逆向回退。

### 11. TaskStateBase

```typescript
// src/Task.ts:45-57
interface TaskStateBase {
  id: string
  type: TaskType
  status: TaskStatus
  parentTaskId?: string
  messages: Message[]
  createdAt: number
  completedAt?: number
}
```

任务状态的基础接口。`parentTaskId` 建立了任务之间的父子关系树，使得 Agent 嵌套调用可以被追踪和管理。

---

## 五、命令与消息类型

### 12. Command

```typescript
// src/types/command.ts
interface Command {
  name: string
  description: string
  argNames?: string[]
  execute: (args: string[], context: CommandContext) => Promise<void>
}
```

Slash 命令的定义接口。每个 `/command` 对应一个 `Command` 实例，`execute` 方法在用户输入时被调用。

### 13. Message 类型族

```typescript
// src/types/message.ts
type Message = UserMessage | AssistantMessage | SystemMessage | ToolResultMessage

interface UserMessage { role: "user"; content: string }
interface AssistantMessage { role: "assistant"; content: ContentBlock[] }
interface SystemMessage { role: "system"; content: string }
interface ToolResultMessage { role: "tool_result"; toolUseId: string; content: string }
```

消息类型是对话系统的基本单元。采用联合类型而非继承，通过 `role` 字段区分，与 Anthropic API 的消息格式保持一致。

---

## 六、权限与安全类型

### 14. PermissionMode

```typescript
// src/types/permissions.ts
type PermissionMode = "plan" | "acl" | "bypass"
```

三级权限模式：`plan` 模式下每次工具调用都需用户确认；`acl` 模式基于预定义规则自动决策；`bypass` 模式跳过所有权限检查（仅限受信环境）。

### 15. PermissionResult

```typescript
// src/types/permissions.ts
type PermissionResult =
  | { type: "allowed" }
  | { type: "denied"; reason: string }
  | { type: "ask_user"; message: string }
```

权限检查的三种结果，使用判别联合类型（Discriminated Union）确保调用方必须处理每种情况。

---

## 七、基础设施类型

### 16. MCPServerConnection

```typescript
// src/services/mcp/types.ts
interface MCPServerConnection {
  serverId: string
  transport: "stdio" | "sse" | "streamable-http"
  status: "connecting" | "connected" | "disconnected" | "error"
  tools: Tool[]
  capabilities: ServerCapabilities
}
```

MCP 服务器连接的运行时表示。支持三种传输方式：`stdio` 用于本地进程通信，`sse` 用于 Server-Sent Events 流式连接，`streamable-http` 用于标准 HTTP 流式传输。

### 17. BackoffConfig

```typescript
// src/bridge/bridgeMain.ts:59-70
interface BackoffConfig {
  initialDelayMs: number
  maxDelayMs: number
  backoffMultiplier: number
  maxRetries: number
  jitterFraction: number
}
```

Bridge 重连的退避策略配置。`jitterFraction` 引入随机抖动，避免大量客户端在同一时刻重连导致服务端过载——这是分布式系统中经典的"惊群"问题的标准解法。

### 18. EntrypointTruncation

```typescript
// src/memdir/memdir.ts:41-47
interface EntrypointTruncation {
  filePath: string
  originalLength: number
  truncatedLength: number
  reason: "token_limit" | "max_entries"
}
```

Memory 系统在加载入口文件时的截断记录。当记忆文件超出 Token 限制时，系统会截断并保留此记录，以便后续判断是否需要重新加载完整内容。

---

## 八、速查索引表

| 类型名 | 文件位置 | 相关章节 | 用途 |
|--------|----------|----------|------|
| Tool | src/Tool.ts:362-504 | 第 7 章 | 工具定义与执行 |
| ToolResult\<T\> | src/Tool.ts:321-336 | 第 7 章 | 工具执行返回值 |
| ToolUseContext | src/Tool.ts:158-300 | 第 7 章 | 工具调用上下文 |
| ToolPermissionContext | src/Tool.ts:123-138 | 第 17 章 | 权限检查上下文 |
| AppState | src/state/AppStateStore.ts:89-158 | 第 16 章 | 全局应用状态 |
| Store\<T\> | src/state/store.ts:4-8 | 第 16 章 | 状态容器接口 |
| QueryEngineConfig | src/QueryEngine.ts:130-173 | 第 6 章 | 查询引擎配置 |
| QueryEngine | src/QueryEngine.ts:184 | 第 6 章 | 核心查询引擎 |
| TaskType | src/Task.ts:6-13 | 第 13 章 | 任务类型枚举 |
| TaskStatus | src/Task.ts:15-20 | 第 13 章 | 任务状态枚举 |
| TaskStateBase | src/Task.ts:45-57 | 第 13 章 | 任务状态基类 |
| Command | src/types/command.ts | 第 8 章 | Slash 命令定义 |
| Message | src/types/message.ts | 第 6 章 | 对话消息类型 |
| PermissionMode | src/types/permissions.ts | 第 17 章 | 权限模式枚举 |
| PermissionResult | src/types/permissions.ts | 第 17 章 | 权限检查结果 |
| MCPServerConnection | src/services/mcp/types.ts | 第 18 章 | MCP 连接管理 |
| BackoffConfig | src/bridge/bridgeMain.ts:59-70 | 第 14 章 | 重连退避策略 |
| EntrypointTruncation | src/memdir/memdir.ts:41-47 | 第 20 章 | 记忆截断信息 |

以上 18 个类型覆盖了 Claude Code 中最常遇到的接口定义。阅读源码时，建议将本附录作为随身参考，遇到陌生类型时先查阅此表定位文件和章节，再深入对应的正文获取完整上下文。
