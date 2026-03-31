# 第 11 章 搜索与发现工具

> "在一个足够大的代码库中，找到正确的文件比修改它更难。" —— 匿名工程师

代码搜索是开发者日常工作中最高频的操作之一。Claude Code 提供了三个层次分明的搜索工具：GlobTool 负责文件名模式匹配，GrepTool 负责文件内容搜索，LSPTool 则借助语言服务器提供语义级别的代码理解。本章将逐一剖析这三个工具的实现细节。

## 11.1 GlobTool：快速的文件发现

GlobTool 位于 `src/tools/GlobTool/GlobTool.ts`，它的职责是根据模式匹配找到符合条件的文件路径。

### 输入设计

```typescript
// src/tools/GlobTool/GlobTool.ts, Lines 26-36
const inputSchema = lazySchema(() =>
  z.strictObject({
    pattern: z.string().describe('The glob pattern to match files against'),
    path: z.string().optional().describe('The directory to search in...'),
  }),
)
```

输入参数极其简洁——一个 glob 模式加一个可选的搜索目录。`pattern` 支持标准的 glob 语法，如 `**/*.ts` 匹配所有 TypeScript 文件，`src/**/test_*.py` 匹配 `src` 目录下所有以 `test_` 开头的 Python 文件。当 `path` 未指定时，默认使用当前工作目录。

### 输出结构

```typescript
// src/tools/GlobTool/GlobTool.ts, Lines 39-52
// 输出包含：
//   durationMs  -- 搜索耗时（毫秒）
//   numFiles    -- 匹配的文件数量
//   filenames   -- 文件路径数组
//   truncated   -- 结果是否被截断
```

输出中包含 `durationMs` 字段，这是一个常被忽视但很有价值的设计。它让 LLM 能够感知搜索性能——如果一次 glob 操作耗时过长，LLM 可以据此决定缩小搜索范围或调整策略。`truncated` 字段则告知调用方是否有更多结果未被返回，避免因结果截断导致的信息遗漏。

### 并发安全与只读标记

```typescript
// src/tools/GlobTool/GlobTool.ts, Lines 57-80
// buildTool 定义
// isConcurrencySafe: true  -- 可安全并发执行
// isReadOnly: true          -- 不修改任何状态
```

`isConcurrencySafe: true` 意味着多个 GlobTool 调用可以同时执行而不会互相干扰。这个属性在并行搜索场景中至关重要——当 LLM 需要同时在多个目录中查找不同类型的文件时，这些搜索可以并发进行，大幅缩短总耗时。

`isReadOnly: true` 标记告知权限系统这个工具不会修改任何文件系统状态，因此可以跳过写入相关的权限检查。

实际的 glob 匹配逻辑委托给了 `src/utils/glob.ts` 工具模块。这个模块封装了底层的文件系统遍历和模式匹配算法，并对结果按修改时间排序——最近修改的文件排在前面，这符合开发者"最近改动的文件最可能是我要找的"的直觉。

## 11.2 GrepTool：基于 ripgrep 的内容搜索

如果说 GlobTool 回答的是"哪些文件存在"，那么 GrepTool 回答的就是"哪些文件包含特定内容"。它的实现位于 `src/tools/GrepTool/GrepTool.ts`，底层依赖 ripgrep（`rg`）——一个以性能著称的文本搜索工具。

### 丰富的输入参数

```typescript
// src/tools/GrepTool/GrepTool.ts, Lines 33-79
// 输入参数：
//   pattern      -- 正则表达式搜索模式
//   path         -- 搜索路径（默认当前目录）
//   glob         -- 文件名过滤（如 "*.js"）
//   output_mode  -- 'content' | 'files_with_matches' | 'count'
//   '-B'         -- 匹配行之前的上下文行数
//   '-A'         -- 匹配行之后的上下文行数
//   '-C'         -- 前后上下文行数
//   '-n'         -- 显示行号
//   '-i'         -- 大小写不敏感
//   type         -- 文件类型过滤（如 "js", "py"）
//   head_limit   -- 限制返回结果数
//   offset       -- 跳过前 N 条结果
//   multiline    -- 启用跨行匹配
```

这套参数设计直接映射了 ripgrep 的核心选项，同时增加了 `head_limit` 和 `offset` 两个分页参数。参数名使用了 `-B`、`-A`、`-C`、`-n`、`-i` 这样的短横线前缀形式，与 `rg` 命令行参数保持一致。这种设计降低了 LLM 的学习成本——如果它知道如何使用 `rg`，就自然知道如何使用 GrepTool。

### 三种输出模式

GrepTool 提供三种输出模式，适应不同的使用场景：

- **content**：返回匹配行的完整内容，支持上下文行。这是最详细的模式，适合需要阅读具体代码的场景
- **files_with_matches**：只返回包含匹配的文件路径。这是默认模式，适合快速定位文件
- **count**：返回每个文件中的匹配次数。适合评估某个模式在代码库中的分布情况

### 执行流程

```
GrepTool.call({ pattern, path, glob, output_mode, ... })
  |
  +-- 解析搜索路径
  |     +-- path 已指定 -> 使用指定路径
  |     +-- path 未指定 -> 使用当前工作目录
  |
  +-- 构建 ripgrep 参数列表
  |     +-- --regexp <pattern>
  |     +-- --glob <filter>      (若指定)
  |     +-- --type <filetype>    (若指定)
  |     +-- -B/-A/-C <context>   (若指定)
  |     +-- -i                   (若大小写不敏感)
  |     +-- -U --multiline-dotall (若跨行匹配)
  |     +-- --line-number / --files-with-matches / --count
  |
  +-- 执行 rg 子进程 (src/utils/ripgrep.ts)
  |
  +-- 解析输出结果
  |     +-- content 模式 -> 保留完整匹配内容
  |     +-- files_with_matches -> 提取文件路径列表
  |     +-- count 模式 -> 提取匹配计数
  |
  +-- 应用 offset 跳过
  +-- 应用 head_limit 截断
  +-- 返回格式化结果
```

`src/utils/ripgrep.ts` 作为 ripgrep 的封装层，负责将结构化参数转换为命令行调用，并解析 `rg` 的输出。选择 ripgrep 而非内置的正则搜索是一个务实的决策——ripgrep 在大型代码库上的搜索性能远超纯 JavaScript 实现，它默认忽略 `.gitignore` 中列出的文件，并且能够自动检测二进制文件并跳过。

### 跨行匹配

`multiline` 参数开启后，GrepTool 会传递 `-U --multiline-dotall` 标志给 ripgrep，使得 `.` 可以匹配换行符，正则模式可以跨越多行。这在搜索跨行的代码结构时非常有用，例如查找特定的函数定义（函数签名可能跨越多行）或多行的配置块。

## 11.3 LSPTool：语义级代码理解

GlobTool 和 GrepTool 都是基于文本的搜索工具——它们不理解代码的语义。LSPTool 则通过 Language Server Protocol 引入了语义层面的代码分析能力。

LSP 服务管理的核心位于 `src/services/lsp/manager.ts`，它负责语言服务器的生命周期管理——启动、初始化、通信和关闭。当 Claude Code 打开一个项目时，LSP manager 会根据项目中的文件类型决定启动哪些语言服务器（如 TypeScript 项目启动 `tsserver`，Python 项目启动 `pyright`）。

`src/services/lsp/LSPDiagnosticRegistry.ts` 则维护了一个诊断信息的注册表。语言服务器会持续分析代码，报告错误、警告和提示信息。DiagnosticRegistry 收集这些信息并使其可被查询，让 LLM 能够了解代码中存在的问题。

```
LSP 交互流程

项目打开
  |
  +-- LSP Manager 启动对应语言服务器
  |     +-- 发送 initialize 请求
  |     +-- 交换客户端/服务端能力
  |     +-- 发送 initialized 通知
  |
  +-- 持续分析
  |     +-- 文件变更 -> textDocument/didChange
  |     +-- 诊断更新 -> textDocument/publishDiagnostics
  |     +-- DiagnosticRegistry 收集并索引
  |
  +-- 按需查询
        +-- 跳转到定义 -> textDocument/definition
        +-- 查找引用 -> textDocument/references
        +-- 获取诊断 -> 从 Registry 查询
```

LSP 的语义理解能力使得 Claude Code 可以执行文本搜索无法完成的操作：准确地找到一个符号的定义位置（而非所有出现该字符串的地方），找到一个函数的所有调用者，或者理解一个类型的继承关系。

## 11.4 三层搜索策略

三个搜索工具形成了由粗到细的搜索策略：

```
搜索粒度递进

GlobTool (文件级)       "项目中有哪些 TypeScript 文件？"
    |                    pattern: "**/*.ts"
    v
GrepTool (内容级)       "哪些文件中定义了 Router 类？"
    |                    pattern: "class Router"
    v
LSPTool  (语义级)       "Router.navigate 方法在哪里被调用？"
                         textDocument/references
```

LLM 在实际使用中会根据问题的性质灵活组合这三个工具。对于"找到所有配置文件"这类需求，GlobTool 足矣；对于"找到处理认证逻辑的代码"，GrepTool 更为合适；而对于"这个函数的修改会影响哪些调用方"，则需要 LSPTool 的语义分析能力。

## 本章小结

Claude Code 的搜索工具体系体现了分层设计的思想。GlobTool 在文件名层面提供快速的模式匹配，具备并发安全和只读的特性，适合大规模的文件发现任务。GrepTool 在文件内容层面提供基于 ripgrep 的高性能正则搜索，三种输出模式覆盖了从概览到详查的不同需求。LSPTool 在代码语义层面通过语言服务器协议提供类型感知的代码导航。三个工具从文本到语义逐层递进，共同构成了 LLM 理解和探索代码库的感知系统。这种分层架构的优势在于，简单的问题用轻量的工具快速解决，复杂的问题才调用重量级的语义分析，在响应速度和分析深度之间取得了良好的平衡。
