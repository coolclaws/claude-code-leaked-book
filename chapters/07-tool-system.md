# 第 7 章 Tool System

> "Give me a lever long enough and a fulcrum on which to place it, and I shall move the world."
> — Archimedes

如果 QueryEngine 是 Claude Code 的心脏，那么 Tool System 就是它的双手。模型的每一个"意图"——读文件、写代码、执行命令、搜索内容——最终都要通过一个具体的 Tool 实例来转化为真实的操作。Tool System 的设计决定了 Claude Code 能做什么、不能做什么、以及在做之前需要经过怎样的验证和授权。

## 7.1 Tool 类型定义：一个完整的契约

Tool 的类型定义位于 `src/Tool.ts`，是一个包含二十余个字段和方法的泛型接口。它不仅仅描述了"如何调用一个工具"，更定义了工具在整个系统中的完整行为契约：

```typescript
// src/Tool.ts:362-466 (核心字段摘录)
export type Tool<Input, Output, P> = {
  aliases?: string[]
  searchHint?: string
  call(args, context, canUseTool, parentMessage, onProgress?):
    Promise<ToolResult<Output>>
  description(input, options): Promise<string>
  readonly inputSchema: Input
  outputSchema?: z.ZodType<unknown>
  isConcurrencySafe(input): boolean
  isReadOnly(input): boolean
  isDestructive?(input): boolean
  interruptBehavior?(): 'cancel' | 'block'
  isSearchOrReadCommand?(input): { isSearch, isRead, isList? }
  readonly name: string
  maxResultSizeChars: number
  readonly strict?: boolean
  validateInput?(input, context): Promise<ValidationResult>
  checkPermissions(input, context): Promise<PermissionResult>
  ...
}
```

这个接口中的每个方法都承担着特定的职责，下面逐一分析关键成员。

`call` 是工具的核心执行方法，接收解析后的参数、执行上下文、权限检查函数以及可选的进度回调。返回值是一个 `ToolResult`，其结构同样值得关注：

```typescript
// src/Tool.ts:321-336
export type ToolResult<T> = {
  data: T
  newMessages?: (UserMessage | AssistantMessage |
    AttachmentMessage | SystemMessage)[]
  contextModifier?: (context: ToolUseContext) => ToolUseContext
  mcpMeta?: { _meta?, structuredContent? }
}
```

`ToolResult` 不只是简单地返回数据。`newMessages` 允许工具向对话历史中注入额外的消息——例如 Agent 工具在子对话完成后，可以将整个子对话的摘要作为新消息注入。`contextModifier` 更强大：它允许工具修改后续工具调用的上下文，实现一种受控的副作用传播。

`isConcurrencySafe` 和 `isReadOnly` 这对方法共同决定了工具的并发策略。只读且并发安全的工具（如 FileRead、Glob）可以在 StreamingToolExecutor 中并行执行；而有写入副作用的工具（如 Bash、FileWrite）通常需要串行执行以保证一致性。

`isDestructive` 标记了工具操作是否具有破坏性，这直接影响权限检查的严格程度。`interruptBehavior` 则定义了当用户按下中断键时工具应该如何响应——立即取消还是阻塞等待完成。

## 7.2 输入验证：Zod Schema 的深度应用

Claude Code 中每个工具的输入参数都通过 Zod Schema 进行严格验证。这一机制通过 `buildTool` 工厂函数和 `lazySchema` 模式实现。

`inputSchema` 字段定义了工具接受的参数结构。当模型返回一个 `tool_use` 块时，QueryEngine 会首先将 JSON 参数通过对应工具的 Zod Schema 进行解析。如果解析失败——比如缺少必填字段、类型不匹配、枚举值无效——错误信息会被格式化为 `tool_result` 返回给模型，让模型修正参数后重试。

```
工具输入验证流程
================================

模型返回 tool_use 块
  |
  +-- 提取 JSON 参数
  |
  +-- Zod Schema 解析 (inputSchema)
  |     |
  |     +-- 解析成功 --> validateInput() 业务校验
  |     |                  |
  |     |                  +-- 校验通过 --> checkPermissions()
  |     |                  +-- 校验失败 --> 返回错误给模型
  |     |
  |     +-- 解析失败 --> 格式化错误信息
  |                       返回 tool_result(error) 给模型
  |
  +-- 模型根据错误信息修正参数并重试
```

除了 Schema 级别的结构验证，部分工具还实现了 `validateInput` 方法进行更深层的业务逻辑校验。例如 FileEdit 工具会验证目标文件是否存在、待替换的文本是否在文件中唯一等。这种两层验证机制——结构验证加业务验证——将无效输入挡在实际执行之前，既保护了系统安全，也帮助模型更快地收敛到正确的参数。

`strict` 字段控制了 Schema 的严格模式。当设为 `true` 时，API 层面会启用 Structured Output 约束，确保模型生成的 JSON 严格符合 Schema 定义，而非依赖后置验证。

## 7.3 权限模型：三级授权机制

Tool System 的权限模型是 Claude Code 安全架构的核心。每个工具都必须实现 `checkPermissions` 方法，而执行上下文中的 `toolPermissionContext` 提供了三级授权规则：

```typescript
// src/Tool.ts:158-300 (ToolUseContext 中的权限相关字段)
// toolPermissionContext: {
//   mode: 权限模式
//   rules: {
//     alwaysAllow: 始终允许的工具/操作列表
//     alwaysDeny: 始终拒绝的工具/操作列表
//     alwaysAsk: 始终需要询问的工具/操作列表
//   }
// }
```

三级授权的执行逻辑如下。首先检查 `alwaysDeny` 列表——如果匹配，直接拒绝，不会提示用户。然后检查 `alwaysAllow` 列表——如果匹配，静默通过，不打断工作流。最后，如果两个列表都不匹配，则进入交互式询问流程，由用户实时决定是否允许。`alwaysAsk` 列表中的操作即使在宽松模式下也会强制询问。

```
权限检查流程
================================

tool.checkPermissions(input, context)
  |
  +-- 匹配 alwaysDeny?
  |     +-- 是 --> 拒绝 (记录到 permissionDenials)
  |
  +-- 匹配 alwaysAllow?
  |     +-- 是 --> 允许 (静默通过)
  |
  +-- 匹配 alwaysAsk 或未匹配任何规则?
        +-- 弹出交互式权限对话框
        +-- 用户选择: 允许 / 拒绝 / 始终允许
```

这套权限系统的配置来源是多层叠加的：全局配置文件 `~/.claude/settings.json`、项目级配置 `.claude/settings.json`、以及运行时的用户选择都会影响最终的规则集。`canUseTool` 函数将这些来源合并后传递给 QueryEngine，确保权限决策的一致性。

## 7.4 工具注册表：核心工具与特性门控

`src/tools.ts` 是工具注册的中心入口。它将工具分为两类：始终可用的核心工具，和受特性开关控制的扩展工具。

```typescript
// src/tools.ts:3-12 (核心工具导入)
// 始终可用的核心工具:
// Agent, Skill, Bash, FileEdit, FileRead, FileWrite,
// Glob, NotebookEdit, WebFetch, TaskStop, Brief
```

这些核心工具覆盖了 AI 编程助手的基本能力：文件读写（FileRead, FileWrite, FileEdit）、代码搜索（Glob）、命令执行（Bash）、子任务委派（Agent）、技能调用（Skill）、网络请求（WebFetch）以及流程控制（TaskStop, Brief）。

```typescript
// src/tools.ts:16-52 (特性门控工具)
// REPLTool       --> ant-only (内部专用)
// SleepTool      --> PROACTIVE / KAIROS
// cronTools      --> AGENT_TRIGGERS
// ...
```

特性门控工具只在满足特定条件时才会注册到工具列表中。例如 `REPLTool` 仅对 Anthropic 内部用户（`ant-only`）可用，`SleepTool` 在主动式模式（PROACTIVE/KAIROS）下才有意义。这种门控机制确保了不同部署环境和用户群体获得恰当的工具集合。

值得注意的是 Agent 工具的特殊限制：

```typescript
// src/tools.ts:98-103
// Agent 工具有一个 disallowed tool 列表
// 限制子 Agent 不能使用某些工具，防止递归嵌套或权限提升
```

这防止了 Agent 调用 Agent 形成无限递归，或者子 Agent 调用高权限工具绕过安全边界。

## 7.5 buildTool 工厂模式

每个具体的工具实现都遵循统一的 `buildTool` 工厂模式。这个工厂函数接收 Zod Schema 定义和方法实现，返回一个符合 `Tool` 接口的完整对象。`lazySchema()` 模式确保 Schema 的构造是惰性的——只在首次访问时才会执行 Zod 的 Schema 构建逻辑，避免在启动时为所有工具（包括那些可能永远不会被调用的工具）预先构建 Schema。

`toolMatchesName` 和 `findToolByName` 两个辅助函数（位于 Tool.ts 的 348-360 行）负责通过名称或别名查找工具，支持精确匹配和别名匹配，使得模型可以用多种名称引用同一个工具。

## 本章小结

Claude Code 的 Tool System 通过一个精心设计的 `Tool` 泛型接口，为每个工具定义了从输入验证、权限检查到执行反馈的完整契约。Zod Schema 提供了结构级和业务级的双层输入验证，将无效调用挡在执行之前。三级授权机制（alwaysDeny / alwaysAllow / alwaysAsk）在安全性和流畅性之间取得平衡。工具注册表通过特性门控区分核心工具和扩展工具，`buildTool` 工厂模式则保证了实现的一致性。`ToolResult` 中的 `contextModifier` 和 `newMessages` 机制赋予了工具影响后续执行上下文的能力，使得工具之间可以形成协作链条。这套系统的设计理念可以归结为一句话：让模型拥有强大的能力，同时确保每一步都在类型安全和权限控制的约束之下。
