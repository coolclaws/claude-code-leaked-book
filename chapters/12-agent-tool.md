# 第 12 章 AgentTool 与子 Agent

> "The best way to solve a big problem is to break it into smaller problems and delegate."
> — 改编自 Elon Musk

在前面的章节中，我们已经了解了 QueryEngine 如何驱动单个对话循环。但当任务足够复杂时，一个 Agent 往往不够用——它可能需要同时探索代码库的多个角落、在隔离环境中进行危险操作、或者并行执行多个子任务。AgentTool 正是为此而生：它允许主 Agent 产生子 Agent，每个子 Agent 拥有独立的 QueryEngine 实例、独立的工具集、甚至独立的工作目录。

本章将深入分析 AgentTool 的输入输出 Schema 设计、子 Agent 的生命周期管理、以及后台运行与工作树隔离等高级特性。

## 12.1 输入 Schema 的分层设计

AgentTool 的输入 Schema 采用了分层设计——基础层和扩展层，通过特性开关动态决定最终暴露给模型的参数集合。

基础层定义了每个子 Agent 调用都需要的核心参数：

```typescript
// src/tools/AgentTool/AgentTool.tsx:82-88
const baseInputSchema = lazySchema(() => z.object({
  description: z.string().describe('A short (3-5 word) description of the task'),
  prompt: z.string().describe('The task for the agent to perform'),
  subagent_type: z.string().optional().describe('The type of specialized agent...'),
  model: z.enum(['sonnet', 'opus', 'haiku']).optional(),
  run_in_background: z.boolean().optional(),
}));
```

`description` 字段限制在 3-5 个单词，这并非随意的约束。子 Agent 的描述会显示在 UI 的任务列表中，过长的描述会破坏终端布局。`prompt` 是传递给子 Agent 的完整任务指令，而 `subagent_type` 决定了子 Agent 的能力边界。

扩展层在基础层之上增加了更多控制参数：

```typescript
// src/tools/AgentTool/AgentTool.tsx:91-102
// 扩展字段包括：
// name: 自定义 Agent 名称
// team_name: 所属团队名称
// mode: 运行模式
// isolation: 'worktree' | 'remote' 隔离级别
// cwd: 自定义工作目录
```

这里的 `isolation` 字段特别值得注意。当设置为 `worktree` 时，子 Agent 会在一个独立的 Git 工作树中运行，这意味着它可以自由地修改文件、切换分支，而不会影响主 Agent 的工作目录。这是一种优雅的隔离策略——利用 Git 自身的工作树机制，而非依赖容器或虚拟机。

最终暴露的 Schema 由特性开关在运行时决定：

```typescript
// src/tools/AgentTool/AgentTool.tsx:110-125
// 特性开关 KAIROS 控制是否启用团队相关字段
// 特性开关 FORK_SUBAGENT 控制是否启用隔离模式
```

这种动态 Schema 的做法意味着不同用户看到的 AgentTool 能力是不同的。一个未启用 KAIROS 特性的用户，模型根本不会知道 `team_name` 参数的存在，自然也不会尝试使用它。这比简单地在文档中标注"实验性功能"要彻底得多。

## 12.2 输出 Schema：同步与异步的二元结构

AgentTool 的输出根据执行模式分为两种变体：

```typescript
// src/tools/AgentTool/AgentTool.tsx:141-150
// 同步模式 (completed): 返回子 Agent 的完整执行结果
// 异步模式 (async_launched): 返回 agentId，调用方后续轮询
```

同步模式下，主 Agent 会阻塞等待子 Agent 完成，然后将结果直接聚合到当前对话流中。异步模式下，子 Agent 在后台运行，主 Agent 可以继续执行其他任务，稍后通过 `agentId` 查询结果。

这种设计直接映射了现实世界的协作模式：有些任务需要立即得到答案（"这个函数的返回类型是什么？"），有些则适合放到后台慢慢做（"重构整个模块的错误处理逻辑"）。

## 12.3 子 Agent 类型体系

AgentTool 支持四种子 Agent 类型，每种类型对应不同的工具权限和使用场景：

```
+------------------+----------+----------------------------+
| subagent_type    | 工具权限 | 典型场景                    |
+------------------+----------+----------------------------+
| general-purpose  | 完整     | 代码修改、文件创建           |
| Explore          | 只读     | 快速代码搜索、依赖追踪       |
| Plan             | 只读     | 架构分析、方案设计           |
| 自定义 Agent      | 自定义   | 从 .claude/agents/ 加载    |
+------------------+----------+----------------------------+
```

`Explore` 和 `Plan` 类型是只读的，它们只能使用 Read、Grep、Glob 等搜索工具，无法修改文件或执行 Shell 命令。这种约束确保了安全性——当主 Agent 只是需要搜集信息时，产生的子 Agent 不会意外地修改代码库。

自定义 Agent 的加载逻辑位于独立的模块中：

```typescript
// src/tools/AgentTool/loadAgentsDir.ts
// 从 .claude/agents/ 目录加载自定义 Agent 定义
// 每个定义文件指定 Agent 的名称、系统提示词、可用工具列表
```

这使得团队可以预定义专用 Agent。例如，一个前端团队可能定义一个 `css-reviewer` Agent，它只关注样式文件并遵循团队的 CSS 规范。这些定义存储在项目仓库中，团队成员共享同一套 Agent 配置。

## 12.4 子 Agent 生命周期

一个子 Agent 从创建到完成，经历以下完整流程：

```
AgentTool.call(input)
  |
  v
[1] 解析 subagent_type
  |-- 内置类型 -> 使用预定义配置
  |-- 自定义类型 -> 从 .claude/agents/ 加载
  |
  v
[2] 构建 Agent 上下文
  |-- 筛选可用工具集
  |-- 设置工作目录 (cwd)
  |-- 创建 AbortController
  |
  v
[3] 判断执行模式
  |
  +-- run_in_background == true
  |     |
  |     v
  |   [3a] 注册为 LocalAgentTask
  |     |-- 分配 taskId (前缀 'a')
  |     |-- 绑定 ProgressTracker
  |     |-- 返回 { type: 'async_launched', agentId }
  |
  +-- isolation == 'worktree'
  |     |
  |     v
  |   [3b] 创建 Git 工作树
  |     |-- git worktree add <path>
  |     |-- 将子 Agent cwd 指向工作树
  |     |-- 完成后 git worktree remove
  |
  +-- 同步执行 (默认)
        |
        v
      [4] 创建子 QueryEngine 实例
        |-- 继承父级部分配置
        |-- 注入过滤后的工具集
        |-- 设置 maxTurns 防止无限循环
        |
        v
      [5] 执行对话循环
        |-- 将 prompt 作为 user message 注入
        |-- 进入 QueryEngine 主循环
        |-- 子 Agent 可调用工具、产生输出
        |
        v
      [6] 收集结果
        |-- 提取最终 assistant message
        |-- 返回 { type: 'completed', result }
```

步骤 [4] 中"继承父级部分配置"是一个微妙的细节。子 Agent 会继承父级的 MCP 客户端连接、权限检查函数、应用状态访问器，但不会继承父级的消息历史。每个子 Agent 都从空白对话开始，只接收传入的 `prompt` 作为第一条用户消息。这确保了子 Agent 的上下文窗口是干净的，不会被父级的冗长对话历史所干扰。

## 12.5 后台 Agent 与 ProgressTracker

当 `run_in_background` 为 `true` 时，子 Agent 被包装为一个 `LocalAgentTask`：

```typescript
// src/tasks/LocalAgentTask/LocalAgentTask.tsx
// LocalAgentTask 实现了 TaskHandle 接口
// 内部维护 ProgressTracker 实例
// 支持状态查询、输出流读取、取消操作
```

`ProgressTracker` 的职责是将子 Agent 的执行进度（正在调用什么工具、已经执行了几个轮次、当前输出内容）实时报告给 UI 层。主 Agent 返回的 `agentId` 可以被后续的工具调用用来查询进度或等待完成。

这种后台执行模式在处理耗时任务时尤为有用。假设用户要求"同时检查项目中所有 TODO 注释并为每个创建 Issue"，主 Agent 可以为每个模块产生一个后台子 Agent，然后汇总所有结果。

## 12.6 工作树隔离的实现细节

`isolation: 'worktree'` 模式利用了 Git 的 worktree 特性。其核心思路是：为子 Agent 创建一个独立的工作目录，该目录共享同一个 Git 仓库但拥有独立的工作树和索引。

```
主工作目录: /project
  |
  +-- .git/           (共享)
  |
  +-- worktrees/
        |
        +-- agent-a8k3mf2p/   (子 Agent 工作树)
              |-- src/
              |-- package.json
              |-- ...
```

这种隔离带来了几个好处：子 Agent 可以安全地修改任何文件而不影响主 Agent 的文件状态；子 Agent 甚至可以切换到不同的 Git 分支进行操作；当子 Agent 完成后，工作树被清理，所有临时变更都消失。如果子 Agent 产生了有价值的变更，可以通过 Git 的正常流程（commit、cherry-pick）将其合并回主分支。

## 本章小结

AgentTool 是 Claude Code 实现多 Agent 协作的基石。它通过分层的输入 Schema 和特性开关实现灵活的能力控制，通过四种子 Agent 类型覆盖不同的使用场景，通过同步/异步两种执行模式适应不同的任务特征，通过 Git 工作树实现安全的文件系统隔离。每个子 Agent 本质上是一个独立的 QueryEngine 实例，拥有干净的上下文和受限的工具集，既保证了执行的安全性，也确保了上下文窗口的高效利用。下一章我们将看到，当多个子 Agent 需要协同工作时，Team 与 Task 系统如何在此基础上实现更复杂的多 Agent 编排。
