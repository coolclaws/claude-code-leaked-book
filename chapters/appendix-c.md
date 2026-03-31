# 附录 C：名词解释

本书涉及大量技术术语，部分来自 Claude Code 项目自身的命名约定，部分来自更广泛的技术生态。本附录按主题分类汇总了全书出现的关键术语，每条包含英文原名、中文释义和在 Claude Code 中的具体含义。

---

## 一、AI 与协议

| 术语 | 全称 | 释义 |
|------|------|------|
| **MCP** | Model Context Protocol | Anthropic 发布的开放协议，用于将 AI 模型与外部工具和数据源连接。Claude Code 既作为 MCP 客户端连接外部服务器，其工具系统设计也深受该协议影响。详见第 18 章。 |
| **Prompt Cache** | — | Anthropic API 提供的缓存特性，允许重用已计算的 prompt 前缀。当对话历史中有大量不变内容（如系统提示词）时，缓存可以显著减少 Token 消耗和响应延迟。Claude Code 在 `QueryEngineConfig` 中通过 `promptCacheEnabled` 字段控制此特性。 |
| **Elicitation** | — | MCP 协议中的一项特性，允许服务器在处理请求过程中主动向客户端（即用户）请求额外输入。这打破了传统的单向请求-响应模式，使工具交互更加灵活。 |
| **SSE** | Server-Sent Events | 一种基于 HTTP 的单向流式协议，服务器可以持续向客户端推送事件。在 MCP 中作为传输层选项之一，适用于需要实时流式响应但不需要双向通信的场景。 |
| **Coordinator Mode** | — | Claude Code 的多 Agent 协调模式。在该模式下，一个 Coordinator Agent 负责理解用户意图并将任务拆解为子任务，分配给多个 Worker Agent 并行执行。Coordinator 负责汇总结果并呈现给用户。详见第 13 章。 |
| **KAIROS** | — | Claude Code 内部的功能标识符，用于控制助手主动行为相关的能力开关。通过 Feature Gate 机制在运行时决定是否启用，属于实验性功能范畴。 |
| **ToolSearch** | — | Claude Code 中的延迟工具加载机制。为减少初始 prompt 大小，系统不会在启动时将所有工具的完整 Schema 注入 prompt，而是仅提供工具名称列表，当 LLM 需要使用某个工具时再动态加载其 Schema 定义。 |

---

## 二、开发框架与工具链

| 术语 | 释义 |
|------|------|
| **Ink** | 基于 React 的终端 UI 框架，允许使用 JSX 语法构建命令行界面。Claude Code 使用了一个自定义 fork 版本，对渲染性能和布局算法进行了优化。详见第 15 章。 |
| **React Reconciler** | React 的核心调和算法，负责对比新旧虚拟组件树并计算最小更新。Claude Code 的 Ink 框架通过自定义 Reconciler 将 React 组件映射到终端字符输出，而非浏览器 DOM。 |
| **Bun** | 高性能 JavaScript 运行时和打包工具，作为 Node.js 的替代方案。Claude Code 使用 Bun 进行生产环境打包，其启动速度和打包效率相比传统工具链有显著优势。详见第 21 章。 |
| **Zod** | TypeScript 优先的 Schema 验证库，用于在运行时校验数据结构。Claude Code 大量使用 Zod 定义配置文件 Schema、工具输入 Schema 和 API 响应校验，确保类型安全从编译时延伸到运行时。 |
| **GrowthBook** | 开源的功能开关（Feature Flag）和 A/B 实验平台。Claude Code 通过 GrowthBook 控制功能的灰度发布，允许按用户比例逐步开放新特性。 |
| **Statsig** | 分析与实验平台，用于数据采集、指标计算和实验分析。Claude Code 通过 Statsig 上报使用数据和性能指标，支撑产品决策。详见第 22 章。 |

---

## 三、安全与权限

| 术语 | 释义 |
|------|------|
| **Sandbox** | 安全隔离环境，限制被执行代码的系统访问权限。Claude Code 的 Shell 工具在沙箱中运行用户命令，防止 LLM 生成的指令对系统造成破坏。具体实现因操作系统而异，macOS 使用 `sandbox-exec`，Linux 使用容器化方案。详见第 10 章。 |
| **MDM** | Mobile Device Management 的缩写，企业级设备管理系统。在 Claude Code 的上下文中，MDM 配置作为最高优先级的配置层，允许企业 IT 管理员强制覆盖用户和项目级别的设置。详见第 4 章。 |
| **XAA** | Cross-App Access 的缩写，跨应用访问认证机制。用于 MCP 服务器之间的身份验证，确保一个应用中的 MCP 客户端可以安全地访问另一个应用提供的 MCP 服务。 |
| **PermissionMode** | Claude Code 的三级权限模式：`plan` 模式要求每次工具调用都经过用户确认；`acl` 模式基于预定义的允许/拒绝列表自动决策；`bypass` 模式跳过所有检查，仅限完全受信环境。详见第 17 章。 |

---

## 四、架构与模式

| 术语 | 释义 |
|------|------|
| **Bridge** | Claude Code 中连接本地 CLI 客户端与远程执行环境（CCR）的通信系统。Bridge 负责会话建立、消息转发、断线重连和心跳维持，使远程环境对用户透明。详见第 14 章。 |
| **CCR** | Claude Code Remote 的缩写，Claude Code 的远程执行环境。用户可以在本地运行 CLI 界面，而实际的代码操作在远程服务器上执行，通过 Bridge 连接。 |
| **DCE** | Dead Code Elimination 的缩写，构建时的死代码消除优化。Claude Code 通过 `feature()` 函数标记条件代码路径，打包工具在构建时移除未启用的代码分支，减小最终产物体积。详见第 21 章。 |
| **DeepImmutable** | TypeScript 工具类型，递归地将对象及其所有嵌套属性标记为只读。Claude Code 用它包装 `AppState`，在类型层面防止状态被意外修改。与 `Object.freeze` 的运行时冻结不同，`DeepImmutable` 是纯编译时约束，零运行时开销。 |
| **lazySchema** | Claude Code 中延迟构造 Zod Schema 的设计模式。由于系统定义了大量工具，每个工具的输入 Schema 都需要 Zod 对象，如果在模块加载时就构造所有 Schema，会显著拖慢启动速度。`lazySchema` 模式将构造推迟到首次使用时，是经典的惰性初始化优化。 |
| **profileCheckpoint** | 启动性能分析中的埋点标记。在启动流程的关键节点调用 `profileCheckpoint("name")`，记录时间戳，用于后续分析各阶段耗时。详见第 3 章和第 21 章。 |
| **Feature Gate** | 功能开关机制，在运行时或构建时控制某项功能是否可用。运行时 Feature Gate 通过 GrowthBook 动态控制，构建时 Feature Gate 通过 DCE 静态消除。两种机制配合使用，兼顾灵活性和产物体积。 |

---

## 五、Git 与开发流程

| 术语 | 释义 |
|------|------|
| **Worktree** | Git 的工作树功能，允许在同一仓库中同时检出多个分支到不同目录。Claude Code 的 Coordinator Mode 利用 Worktree 让多个 Worker Agent 在各自独立的工作目录中并行操作，避免分支切换导致的冲突。详见第 13 章。 |
| **REPL** | Read-Eval-Print Loop 的缩写，交互式命令循环。Claude Code 本身就是一个 REPL——读取用户输入、交给 LLM 评估、将结果打印到终端、循环往复。这种交互模式贯穿整个产品体验。 |

---

## 六、术语对照速查

为方便快速查找，下表按字母顺序排列所有术语及其首次出现的章节。

| 术语 | 首次出现 | 分类 |
|------|----------|------|
| Bridge | 第 14 章 | 架构 |
| Bun | 第 21 章 | 工具链 |
| CCR | 第 14 章 | 架构 |
| Coordinator Mode | 第 13 章 | AI |
| DCE | 第 21 章 | 架构 |
| DeepImmutable | 第 16 章 | 架构 |
| Elicitation | 第 18 章 | AI |
| Feature Gate | 第 4 章 | 架构 |
| GrowthBook | 第 4 章 | 工具链 |
| Ink | 第 15 章 | 工具链 |
| KAIROS | 第 4 章 | AI |
| lazySchema | 第 7 章 | 架构 |
| MCP | 第 18 章 | AI |
| MDM | 第 4 章 | 安全 |
| PermissionMode | 第 17 章 | 安全 |
| profileCheckpoint | 第 3 章 | 架构 |
| Prompt Cache | 第 6 章 | AI |
| React Reconciler | 第 15 章 | 工具链 |
| REPL | 第 1 章 | 开发 |
| Sandbox | 第 10 章 | 安全 |
| SSE | 第 18 章 | AI |
| Statsig | 第 22 章 | 工具链 |
| ToolSearch | 第 7 章 | AI |
| Worktree | 第 13 章 | Git |
| XAA | 第 5 章 | 安全 |
| Zod | 第 4 章 | 工具链 |

本附录收录了全书 26 个核心术语。技术领域的术语更新速度很快，部分 Claude Code 特有的概念（如 KAIROS、CCR）可能随版本迭代而演变，建议读者结合官方文档获取最新定义。
