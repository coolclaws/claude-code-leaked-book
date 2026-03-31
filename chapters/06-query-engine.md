# 第 6 章 Query Engine

> "The engine of inquiry must be perpetual, for every answer begets a new question."
> — 改编自 Richard Feynman

QueryEngine 是 Claude Code 中最核心的运行时组件——它管理着从用户输入到模型响应再到工具执行的完整对话循环。每一次你在终端中输入一条消息，背后都是 QueryEngine 在驱动整个推理-执行-反馈的闭环。理解它的工作机制，就等于理解了 Claude Code 的心脏。

## 6.1 QueryEngine 的生命周期

QueryEngine 的设计遵循一个简洁的原则：**一次对话对应一个实例，一次提交对应一个轮次**。这一点在类定义的文档注释中说得很清楚：

```typescript
// src/QueryEngine.ts:175-183
/**
 * One QueryEngine per conversation. Each submitMessage() call starts a new turn.
 */
```

每个 QueryEngine 实例在构造时接收一个 `QueryEngineConfig` 配置对象，其中包含了对话所需的全部上下文：工作目录、可用工具、MCP 客户端、权限检查函数、初始消息历史等。类的私有字段清晰地反映了它需要维护的状态：

```typescript
// src/QueryEngine.ts:184-207
export class QueryEngine {
  private config: QueryEngineConfig
  private mutableMessages: Message[]
  private abortController: AbortController
  private permissionDenials: SDKPermissionDenial[]
  private totalUsage: NonNullableUsage
  private discoveredSkillNames = new Set<string>()
  private loadedNestedMemoryPaths = new Set<string>()
  constructor(config: QueryEngineConfig) {
    this.config = config
    this.mutableMessages = config.initialMessages ?? []
    this.abortController = config.abortController ?? createAbortController()
    this.permissionDenials = []
    this.readFileState = config.readFileCache
    this.totalUsage = EMPTY_USAGE
  }
}
```

几个字段值得特别关注。`mutableMessages` 是整个对话的消息数组，注意它是可变的——这是少数几个没有遵循全局不可变状态原则的地方，因为消息列表需要在循环中频繁追加，深拷贝的开销不可接受。`permissionDenials` 记录了本轮对话中被用户拒绝的权限请求，避免模型反复请求同一个已被拒绝的操作。`discoveredSkillNames` 和 `loadedNestedMemoryPaths` 则负责跟踪动态加载的技能和记忆文件，防止重复加载。

## 6.2 QueryEngineConfig：配置全景

`QueryEngineConfig` 类型定义跨越了四十多行，涵盖了 QueryEngine 运行所需的全部配置参数：

```typescript
// src/QueryEngine.ts:130-173 (部分关键字段)
// cwd: 工作目录
// tools: 可用工具列表
// commands: 可用命令列表
// mcpClients: MCP 协议客户端
// canUseTool: 权限检查函数
// getAppState / setAppState: 状态访问器
// initialMessages: 初始消息历史
// customSystemPrompt / appendSystemPrompt: 系统提示词定制
// jsonSchema: 结构化输出约束
// snipReplay: 历史裁剪配置
// maxTurns: 最大对话轮次
// maxBudgetUsd: 预算上限（美元）
```

其中 `maxTurns` 和 `maxBudgetUsd` 是两个关键的安全阀。`maxTurns` 限制了单次 `submitMessage` 调用中模型与工具之间的往返次数，防止模型陷入无限循环。`maxBudgetUsd` 则从费用角度设置了硬性上限——当累计 token 消耗折算成美元后超过此值，QueryEngine 会强制终止循环。这种双重保护机制在生产环境中至关重要。

## 6.3 submitMessage：异步生成器模式

QueryEngine 的核心方法 `submitMessage` 使用了 TypeScript 的 `AsyncGenerator` 模式，这是一个深思熟虑的架构选择：

```typescript
// src/QueryEngine.ts:209-212
async *submitMessage(
  prompt: string | ContentBlockParam[],
  options?: { uuid?: string; isMeta?: boolean },
): AsyncGenerator<SDKMessage, void, unknown> {
```

使用 AsyncGenerator 而非简单的 Promise 或回调，带来了三个关键优势。第一，**流式传递**——调用方可以在每个中间结果产生时立即获取并渲染，无需等待整个循环结束。第二，**背压控制**——如果 UI 层处理不过来，生成器会自然暂停，不会造成消息堆积。第三，**取消支持**——配合 `AbortController`，可以在任何 yield 点中断整个循环。

prompt 参数支持纯文本字符串和结构化的 `ContentBlockParam[]` 两种形式。前者用于普通用户输入，后者用于携带图片、文件附件等多模态内容的场景。

## 6.4 核心循环：query-execute-feedback

`submitMessage` 内部的执行流程可以用以下流程图概括：

```
submitMessage(prompt)
  |
  +-- 构建系统提示词 (getSystemPrompt)
  +-- 加载记忆文件 (loadMemoryPrompt)
  +-- 组装用户消息并追加到 mutableMessages
  |
  +-- LOOP ──────────────────────────────────
  |   |                                      |
  |   +-- 调用 query() 发送 API 请求         |
  |   |     |                                |
  |   |     +-- 流式接收响应块               |
  |   |     +-- 解析 text / tool_use 块      |
  |   |                                      |
  |   +-- 遍历响应中的 tool_use 块           |
  |   |     |                                |
  |   |     +-- Zod Schema 校验输入          |
  |   |     +-- canUseTool 权限检查          |
  |   |     +-- tool.call() 执行工具         |
  |   |     +-- 收集 tool_result             |
  |   |                                      |
  |   +-- 存在 tool_result? ──> 继续循环 ----+
  |   |
  |   +-- 仅文本响应 ──> 跳出循环
  |
  +-- yield 最终 SDKMessage
  +-- 更新 totalUsage 统计
```

这个循环的核心逻辑是：模型每次响应后，检查是否包含 `tool_use` 类型的内容块。如果有，就依次执行每个工具调用，将结果作为 `tool_result` 消息追加到对话历史中，然后再次调用模型。如果模型的响应只包含文本（没有工具调用），说明模型认为任务已完成，循环结束。

这种模式在 AI Agent 领域被称为 ReAct（Reasoning + Acting）模式的一种变体。与经典 ReAct 不同的是，Claude Code 完全依赖模型原生的 tool_use 能力，而非通过提示词模板来解析工具调用意图。

## 6.5 流式响应与工具执行

实际的 API 调用和流式响应处理并不在 QueryEngine 本身中完成，而是委托给了两个专门的模块。

`src/query.ts` 是一个约 68KB 的模块，负责与 Claude API 的实际通信。它处理流式 SSE（Server-Sent Events）的解析、token 计数的累加、错误重试以及响应块的组装。将网络通信层从 QueryEngine 中分离出来，使得 QueryEngine 可以专注于业务逻辑。

`src/services/tools/StreamingToolExecutor.ts` 则负责工具的并发执行。当模型一次返回多个 `tool_use` 块时（这在复杂任务中很常见），StreamingToolExecutor 会判断哪些工具可以并发执行（通过 `isConcurrencySafe` 方法），哪些必须串行。例如，多个 `FileRead` 调用可以安全地并行执行，但 `Bash` 命令通常需要串行以避免竞态条件。

## 6.6 权限拒绝的跟踪机制

当用户拒绝某个工具调用的权限请求时，QueryEngine 不会简单地忽略这一事件，而是将其记录到 `permissionDenials` 数组中：

```typescript
// src/QueryEngine.ts:244-253 (权限拒绝包装逻辑)
// 被拒绝的权限请求会被包装为 SDKPermissionDenial
// 并在后续的 API 调用中作为上下文传递给模型
// 使模型知道哪些操作已被用户明确拒绝
```

这种设计解决了一个实际问题：如果不告诉模型某个操作已被拒绝，它可能会在下一轮继续尝试相同的操作，导致用户反复看到相同的权限弹窗。通过将拒绝信息注入对话上下文，模型可以调整策略，寻找替代方案。

## 6.7 预算与轮次的双重安全网

QueryEngine 在每次循环迭代中都会检查两个约束条件。`maxTurns` 检查当前已经进行了多少轮工具调用，超过阈值则强制停止并向用户报告。`maxBudgetUsd` 则根据 `totalUsage` 中累计的 input/output token 数量，按照模型的定价计算当前花费，超出预算同样会终止循环。

这两个安全机制共同确保了即使模型进入了不理想的执行路径（例如反复读取大文件或执行无效命令），也不会无限制地消耗资源。

## 本章小结

QueryEngine 是 Claude Code 的推理引擎核心，采用 AsyncGenerator 模式实现了流式、可中断、可观察的对话循环。它将系统提示词构建、API 通信、工具执行、权限管理等职责清晰分层：自身专注于循环控制和状态维护，网络通信委托给 `query.ts`，工具并发执行委托给 `StreamingToolExecutor`。通过 `maxTurns` 和 `maxBudgetUsd` 双重安全阀、权限拒绝跟踪机制以及可变消息列表的精心管理，QueryEngine 在灵活性与安全性之间取得了恰当的平衡。理解了这个核心循环，就掌握了 Claude Code 从接收输入到产生行动的完整路径。
