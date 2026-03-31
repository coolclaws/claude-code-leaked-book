# 第 8 章 Command System

> "Simplicity is the ultimate sophistication."
> — Leonardo da Vinci

当用户在 Claude Code 的终端中输入 `/commit`、`/help` 或 `/compact` 时，触发的不是工具调用，而是命令系统（Command System）。与 Tool System 面向模型不同，Command System 面向用户——它是用户直接控制 Claude Code 行为的界面。斜杠命令提供了一组确定性的操作：不需要经过模型推理，不消耗 API token，执行结果可预期。

## 8.1 命令与工具的本质区别

初学者容易混淆命令和工具，但它们在架构中扮演着截然不同的角色。

工具（Tool）是模型的能力延伸——模型决定何时调用、传什么参数，执行结果反馈给模型用于后续推理。而命令（Command）是用户的直接指令——用户手动输入，系统立即执行，结果直接呈现在 UI 中。工具运行在 QueryEngine 的循环内部，命令运行在循环外部。工具的输入经过 Zod Schema 验证，命令的参数由自己的解析逻辑处理。

这种区分的实际意义在于：命令是零延迟、零成本的。输入 `/cost` 查看当前花费，不需要等模型思考，也不会消耗任何 token。输入 `/clear` 清空对话历史，是一个即时的本地操作。

## 8.2 命令注册中心

`src/commands.ts` 是整个命令系统的注册中心。它的结构分为三个层次：标准命令、特性门控命令和附加命令。

标准命令是所有环境下都可用的基础功能集：

```typescript
// src/commands.ts:2-46 (标准命令导入)
// addDir, clear, commit, compact, config, context,
// cost, diff, doctor, help, ide, login, logout,
// memory, mcp, review, session, skills, status, tasks
// ...
```

这些命令覆盖了日常使用的方方面面。`/commit` 生成提交消息并执行 git commit；`/diff` 显示当前工作目录的变更；`/review` 对代码变更进行审查；`/clear` 清空对话上下文；`/compact` 压缩对话历史以节省 token；`/config` 管理配置项；`/doctor` 诊断环境问题；`/mcp` 管理 MCP 服务器连接；`/memory` 查看和编辑记忆文件。

特性门控命令则根据运行环境和特性开关条件性地注册：

```typescript
// src/commands.ts:48-123 (特性门控命令)
// bridge        --> BRIDGE_MODE
// proactive     --> PROACTIVE / KAIROS
// voice         --> VOICE_MODE
// forceSnip     --> HISTORY_SNIP
// workflows     --> WORKFLOW_SCRIPTS
// ...
```

附加命令是后期扩展的功能：

```typescript
// src/commands.ts:124-150 (附加命令)
// thinkback, permissions, plan, fast, hooks,
// files, branch, agents, plugin, version, summary
// ...
```

整体而言，系统中有超过 104 个命令子目录位于 `src/commands/` 下，每个目录对应一个独立的命令模块。这种一命令一目录的组织方式使得添加新命令非常简单——创建新目录、实现接口、在 `commands.ts` 中注册即可。

## 8.3 Command 类型接口

每个命令都遵循统一的类型接口，该接口定义在 `src/types/command.ts` 中，包含以下核心字段：

- `name`：命令名称，即斜杠后面的部分（如 `commit`、`help`）
- `description`：命令的简要描述，用于 `/help` 列表的展示
- `aliases`：命令别名数组，允许同一命令有多个触发名称
- `handler`：命令的执行函数，接收解析后的参数和当前上下文

命令的 handler 函数签名与工具的 call 方法有本质不同。工具的 call 返回 `ToolResult` 供模型消费，而命令的 handler 通常直接操作 UI 状态或执行副作用，返回值用于指示执行是否成功。

## 8.4 命令路由流程

当用户在 REPL 中键入以 `/` 开头的文本时，命令路由机制启动：

```
用户输入 "/commit -m 'fix bug'"
  |
  +-- 检测到 "/" 前缀，进入命令模式
  |
  +-- 提取命令名: "commit"
  |
  +-- 在命令注册表中查找
  |     |
  |     +-- 精确匹配 name 字段
  |     +-- 若未匹配，搜索 aliases 列表
  |     +-- 若仍未匹配，返回 "未知命令" 错误
  |
  +-- 解析剩余参数: ["-m", "fix bug"]
  |
  +-- 调用 command.handler(args, context)
  |
  +-- 将结果渲染到终端
```

路由过程中有几个值得注意的细节。首先是别名机制：部分命令注册了简短别名，方便频繁使用。其次是参数解析的灵活性：不同命令对参数的处理方式不同，有些接受标志位（flags），有些接受位置参数，有些不接受任何参数。每个命令模块自行负责参数的解析和验证，而非由框架统一处理——这种设计牺牲了一定的一致性，但换来了更大的灵活度。

## 8.5 特性门控的实现机制

特性门控是命令系统中一个重要的设计元素。它确保了实验性功能不会泄漏到不该出现的环境中，同时允许在特定条件下启用高级功能。

```
特性门控判定流程
================================

命令注册阶段 (应用启动时)
  |
  +-- 读取特性开关配置
  |     |
  |     +-- GrowthBook 远程配置
  |     +-- 环境变量覆盖
  |     +-- 本地配置文件
  |
  +-- 遍历特性门控命令列表
        |
        +-- BRIDGE_MODE 开启?
        |     +-- 是 --> 注册 /bridge, /remote-control
        |     +-- 否 --> 跳过
        |
        +-- PROACTIVE / KAIROS 开启?
        |     +-- 是 --> 注册 /proactive, /assistant, /brief
        |     +-- 否 --> 跳过
        |
        +-- VOICE_MODE 开启?
        |     +-- 是 --> 注册 /voice
        |     +-- 否 --> 跳过
        |
        +-- DAEMON 开启?
        |     +-- 是 --> 注册 /daemon 子命令
        |     +-- 否 --> 跳过
        |
        +-- WORKFLOW_SCRIPTS 开启?
              +-- 是 --> 注册 /workflows
              +-- 否 --> 跳过
```

注意门控判定发生在注册阶段而非执行阶段。未注册的命令对用户完全不可见——不会出现在 `/help` 列表中，输入后也只会得到"未知命令"的提示。这比在执行时检查权限并报错要干净得多。

五组门控对应着 Claude Code 的五个扩展方向：`BRIDGE_MODE` 对应远程协作场景（如 IDE 集成）；`PROACTIVE/KAIROS` 对应主动式 AI 助手模式（不等用户提问，主动发现并处理问题）；`VOICE_MODE` 对应语音交互；`DAEMON` 对应后台守护进程模式；`WORKFLOW_SCRIPTS` 对应自动化工作流脚本。

## 8.6 典型命令实例分析

以 `/compact` 命令为例，它演示了命令系统的典型工作方式。当对话历史过长导致 token 消耗增加时，用户输入 `/compact` 触发对话压缩。命令的 handler 会调用模型对当前对话历史进行摘要，然后用摘要替换原始历史，从而大幅减少后续请求的 token 数量。

这里有一个有趣的边界情况：`/compact` 虽然是命令，但它的执行过程中实际上需要调用模型 API。这说明命令和工具的界限并非绝对——命令的核心特征是由用户主动触发，但其内部实现可以利用任何系统能力。

再看 `/doctor` 命令：它检查运行环境是否满足要求（Bun 版本、API 密钥配置、网络连通性等），将结果以诊断报告的形式输出。这是一个纯本地命令，不涉及任何 API 调用，执行速度极快。

## 8.7 命令与工具的协作边界

在某些场景下，命令和工具会形成协作关系。例如用户输入 `/commit` 后，命令的 handler 可能会先调用 git diff 获取变更内容，然后将变更传递给模型生成提交消息，最后执行 git commit。在这个过程中，命令充当了用户意图到系统行为的编排者，而具体的文件读取和命令执行可能复用了工具层的能力。

这种分层协作模式使得命令可以组合多种能力来完成复杂的用户请求，同时保持了每一层的职责清晰：命令层负责用户交互和流程编排，工具层负责原子操作的执行。

## 本章小结

Command System 是 Claude Code 面向用户的直接控制界面，与面向模型的 Tool System 形成互补。104 个命令模块按照标准命令、特性门控命令和附加命令三个层次组织在 `src/commands/` 目录下，通过 `src/commands.ts` 统一注册。命令路由支持精确匹配和别名匹配，参数解析由各命令模块自行负责。特性门控在注册阶段而非执行阶段生效，确保实验性功能对非目标用户完全不可见。五组特性门控分别对应远程协作、主动式助手、语音交互、守护进程和工作流脚本五个扩展方向，勾勒出 Claude Code 未来的产品演进路径。命令系统的设计哲学可以概括为：给用户一个零延迟、零成本、确定性的控制通道，让人始终拥有对 AI 行为的最终控制权。
