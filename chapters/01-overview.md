# 第 1 章 全局概览

> "Any sufficiently advanced CLI is indistinguishable from an IDE."
> — 改编自 Arthur C. Clarke

Claude Code 是 Anthropic 推出的官方命令行工具，它将大语言模型 Claude 直接嵌入到开发者的终端中，使其成为一个具有文件读写、代码搜索、Shell 执行等能力的 AI 编程助手。与大多数基于 Web 的 AI 助手不同，Claude Code 运行在本地环境，能够直接操作文件系统、执行命令、调用外部服务，从而实现真正的端到端编程辅助。

本章将从泄露的源码出发，介绍 Claude Code 的整体架构哲学、技术选型以及核心运行流程。

## 1.1 项目基本信息

从 `package.json` 中可以提取出以下关键信息：

- **包名**：`@anthropic-ai/claude-code`
- **版本**：`0.0.0-leaked`（内部开发版本）
- **运行时**：Bun 1.1.0+，采用 ES Module 模块系统
- **UI 框架**：React 19 + 自定义 Ink 框架（位于 `src/ink/`）
- **CLI 解析**：`@commander-js/extra-typings`
- **API SDK**：`@anthropic-ai/sdk ^0.39.0`
- **MCP 协议**：`@modelcontextprotocol/sdk ^1.12.1`
- **特性开关**：`@growthbook/growthbook ^1.4.0`

这些依赖的选择并非随意，每一项都反映了团队在性能、类型安全和开发体验之间的权衡。

## 1.2 架构哲学：终端即应用

Claude Code 的设计理念可以概括为三个关键词：**响应式、不可变、工具驱动**。

**响应式 UI**。传统的 CLI 工具通常采用线性输出模式——打印一行、再打印一行。Claude Code 却完全不同：它使用 React 19 + Ink 构建了一个完整的终端渲染引擎，将终端当作一个响应式画布来使用。这意味着 UI 可以局部刷新、可以有加载动画、可以在流式输出时实时更新——这些在传统 CLI 中很难实现的交互，在 React 的声明式模型下变得自然而然。

**不可变状态**。应用状态被定义为 `DeepImmutable<AppState>` 类型，这意味着所有状态变更都必须通过受控的方式进行，而不是随意修改对象属性。这种模式在前端开发中已被 Redux 等库广泛验证，但在 CLI 工具中实属罕见。不可变状态带来的好处显而易见：状态变更可追踪、时间旅行调试成为可能、并发安全性得到保证。

**工具驱动**。Claude Code 内置了 43+ 个专用工具（Tool），每个工具都通过 Zod Schema 进行参数校验。LLM 的输出并不直接作用于系统，而是通过调用这些预定义的工具来执行实际操作。这种设计将 LLM 的"意图"与"执行"解耦，既保证了安全性，也使得每个操作都有明确的类型约束和权限边界。

## 1.3 技术选型深度解析

### Bun 作为运行时

选择 Bun 而非 Node.js 是一个大胆但合理的决定。Bun 在以下方面具有显著优势：

1. **启动速度**：Bun 的冷启动时间约为 Node.js 的 1/4，对于 CLI 工具而言，每次调用都会经历启动过程，毫秒级的差异会被放大为体感差异。
2. **内置打包器**：Bun 自带 bundler，Claude Code 利用了其 `feature()` 函数实现死代码消除（DCE），在构建时根据特性开关裁剪不需要的代码路径。
3. **原生 TypeScript 支持**：无需额外的编译步骤，`src/entrypoints/cli.tsx` 可以直接被 Bun 执行。
4. **兼容 npm 生态**：Bun 对 Node.js API 的兼容性足以支撑 `@anthropic-ai/sdk` 和 `@modelcontextprotocol/sdk` 等依赖的正常运行。

### React Ink 自定义框架

Claude Code 并没有直接使用社区版的 Ink 库，而是在 `src/ink/` 目录下维护了一个包含 50+ 文件的自定义 Ink 框架。这样做的原因至少有两个：

第一，社区版 Ink 的渲染调度策略并不完全适合 Claude Code 的流式输出场景——LLM 的 token 是逐个到达的，UI 需要在极高频率下进行增量更新，标准 Ink 的 reconciliation 开销在此场景下会成为瓶颈。

第二，自定义框架允许团队对终端底层能力（如光标控制、区域重绘、滚动缓冲区管理）进行精细调控，这些在通用框架中往往被过度抽象。

### Commander.js 类型增强版

CLI 参数解析使用 `@commander-js/extra-typings`，这是 Commander.js 的类型增强版本。它在标准 Commander 之上提供了完整的 TypeScript 类型推导，使得每个命令的参数、选项都能在编译时得到类型检查。这与整个项目高度类型化的风格一脉相承。

## 1.4 主入口与启动流程

Claude Code 的入口是 `src/entrypoints/cli.tsx`，它会引导到核心文件 `src/main.tsx`。启动流程可以用以下 ASCII 图来表示：

```
┌─────────────────────────────────────────────────────┐
│                  CLI Entry (cli.tsx)                 │
│  - 解析 argv                                         │
│  - 快速路径: --version, --help                        │
└──────────────────────┬──────────────────────────────┘
                       │
                       v
┌─────────────────────────────────────────────────────┐
│          Setup (setup.ts) + Bootstrap                │
│  - 加载配置、环境变量                                  │
│  - 初始化 state (bootstrap/state.ts)                 │
│  - 预取 keychain、MDM 设置                            │
└──────────────────────┬──────────────────────────────┘
                       │
                       v
┌─────────────────────────────────────────────────────┐
│           Main Loop (main.tsx) - React Ink App       │
│  - 挂载 React 组件树                                  │
│  - 进入 REPL Loop / 处理查询                          │
└──────────────────────┬──────────────────────────────┘
                       │
                       v
┌─────────────────────────────────────────────────────┐
│           QueryEngine.ts - Message Loop              │
│  - 构造 API 请求                                      │
│  - 处理流式响应                                       │
│  - 解析工具调用指令                                    │
└──────────────────────┬──────────────────────────────┘
                       │
                       v
┌─────────────────────────────────────────────────────┐
│      Tool Execution (StreamingToolExecutor.ts)       │
│  - Zod Schema 校验参数                                │
│  - 执行工具 (Bash, FileRead, Grep...)                 │
│  - 收集结果                                           │
└──────────────────────┬──────────────────────────────┘
                       │
                       v
┌─────────────────────────────────────────────────────┐
│        LLM Response -> State Update -> UI Render     │
│  - 更新 DeepImmutable<AppState>                      │
│  - React reconciliation -> 终端重绘                   │
└─────────────────────────────────────────────────────┘
```

## 1.5 副作用优先的启动策略

`main.tsx` 的开头非常值得注意——它在所有业务逻辑之前，首先执行了一系列副作用操作：

```typescript
// src/main.tsx:1-20
// These side-effects must run before all other imports
import { profileCheckpoint, profileReport } from './utils/startupProfiler.js';
profileCheckpoint('main_tsx_entry');
import { startMdmRawRead } from './utils/settings/mdm/rawRead.js';
startMdmRawRead();
import { startKeychainPrefetch } from './utils/secureStorage/keychainPrefetch.js';
startKeychainPrefetch();
```

这段代码揭示了一个重要的启动优化策略：在 ES Module 的 import 执行顺序保证下，将耗时的 I/O 操作（MDM 配置读取、Keychain 凭据预取）尽早触发，使其与后续模块的加载并行执行。`profileCheckpoint` 则是性能分析桩点，用于追踪启动过程中各阶段的耗时。

这种"副作用优先"的模式在常规开发中是反模式，但在 CLI 工具的冷启动场景中却是一种务实的优化手段——每一毫秒的启动延迟都会影响用户体验。

## 1.6 核心数据流

理解 Claude Code 的关键在于理解它的数据流。整个系统可以简化为一个循环：

1. **用户输入**：通过 REPL 或命令行参数传入查询。
2. **上下文组装**：`context.ts` 收集系统信息、用户偏好、会话历史等。
3. **API 请求**：`QueryEngine.ts` 将上下文和查询打包发送给 Claude API。
4. **流式响应**：API 以 Server-Sent Events 形式返回 token 流。
5. **工具调用**：如果 LLM 决定调用工具，`StreamingToolExecutor.ts` 解析指令、校验参数、执行工具并将结果回传给 LLM。
6. **状态更新**：每次交互的结果都通过不可变更新写入 `AppState`。
7. **UI 渲染**：React 组件响应状态变化，重新渲染终端界面。

步骤 3-5 可能会循环多次（LLM 可以连续调用多个工具），直到 LLM 决定给出最终回答。

## 1.7 与同类工具的定位差异

Claude Code 在设计上与 GitHub Copilot CLI、Cursor 等工具有本质区别。它不是一个 IDE 插件，而是一个独立的终端应用。这意味着：

- 它不依赖任何特定编辑器，在任何终端中都能运行。
- 它拥有完整的系统访问权限，可以执行 Shell 命令、读写任意文件。
- 它的 UI 完全在终端中渲染，依赖自定义的 Ink 框架而非 Web 技术。

这种定位使得 Claude Code 更接近一个"终端里的 AI 同事"，而非一个"编辑器里的补全引擎"。

## 本章小结

本章从泄露的源码出发，梳理了 Claude Code 的全局架构。它是一个基于 Bun 运行时、使用 React Ink 渲染 UI、以不可变状态管理数据、通过 43+ 工具与系统交互的现代 CLI 应用。其技术选型在启动性能（Bun）、UI 表现力（React Ink）、类型安全（TypeScript + Zod）和扩展能力（MCP 协议 + 插件系统）之间取得了平衡。后续章节将逐一深入这些子系统的实现细节。
