---
layout: home

hero:
  name: "Claude Code 源码解析"
  text: "Anthropic 官方 CLI 完整源码深度解读"
  tagline: 22 章 + 3 附录，从架构哲学到实现细节，全面剖析 Claude Code 内部工作原理
  image:
    src: /logo.png
    alt: Claude Code 源码解析
  actions:
    - theme: brand
      text: 开始阅读
      link: /chapters/01-overview
    - theme: alt
      text: GitHub
      link: https://github.com/coolclaws/claude-code-leaked-book

features:
  - icon:
      src: /icons/rocket.svg
    title: 从入口到运行时
    details: 完整追踪 cli.tsx → main.tsx → QueryEngine 的启动链路，理解 Bun + React Ink 的架构选型
  - icon:
      src: /icons/code.svg
    title: 43+ 工具深度拆解
    details: 逐一分析 BashTool、FileEditTool、AgentTool 等核心工具的实现，包含 Zod Schema 验证与权限模型
  - icon:
      src: /icons/search.svg
    title: 高级系统全景
    details: MCP 协议集成、Skills 技能系统、Bridge 远程架构、多 Agent 协调——覆盖所有高级特性
  - icon:
      src: /icons/book.svg
    title: 真实代码引用
    details: 每处分析均标注源码文件路径与行号，所有代码片段来自实际源码，可交叉验证
---

## 本书结构

本书共分 **八个部分**，由浅入深：

| 部分 | 章节 | 主题 |
|------|------|------|
| 第一部分 | 第 1-2 章 | 宏观认知：全局概览与 Repo 结构 |
| 第二部分 | 第 3-5 章 | 启动与初始化：启动序列、配置、认证 |
| 第三部分 | 第 6-8 章 | 核心运行时：Query Engine、Tool、Command |
| 第四部分 | 第 9-11 章 | 工具实现：文件操作、Shell 执行、搜索发现 |
| 第五部分 | 第 12-14 章 | Agent 编排：子 Agent、Team/Task、Bridge |
| 第六部分 | 第 15-17 章 | UI 与交互：React Ink、状态管理、权限系统 |
| 第七部分 | 第 18-20 章 | 高级特性：MCP、Skills、记忆与会话 |
| 第八部分 | 第 21-22 章 | 工程实践：性能优化、可观测性 |

另有 **3 个附录**：推荐阅读路径、核心类型速查、名词解释。

## 源码概况

本书基于 `nirholas/claude-code` 泄露源码分析，该项目为 Anthropic 官方 Claude Code CLI 工具：

- **包名**：`@anthropic-ai/claude-code`
- **运行时**：Bun 1.1.0+
- **UI 框架**：React 19 + 自定义 Ink 终端渲染
- **核心依赖**：`@anthropic-ai/sdk`、`@modelcontextprotocol/sdk`、`@commander-js/extra-typings`
- **工具数量**：43+ 个专用工具
- **命令数量**：104 个斜杠命令
- **代码规模**：src/ 目录含 56 个子目录，数百个 TypeScript 源文件
