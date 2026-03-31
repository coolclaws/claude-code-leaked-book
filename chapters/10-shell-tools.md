# 第 10 章 Shell 执行工具

> "给程序一个 shell，它能做任何事；给程序一个沙箱里的 shell，它能安全地做任何事。" —— 改编自 Alan Perlis

Shell 执行是 Claude Code 最强大也最危险的能力。一条 `rm -rf /` 就足以摧毁整个系统，因此 BashTool 的设计在"能力"与"约束"之间进行了极其精细的平衡。本章将深入分析 BashTool 的安全沙箱机制、命令分类体系以及执行管理策略。

## 10.1 命令分类体系

BashTool 的实现位于 `src/tools/BashTool/BashTool.tsx`。在其文件开头，定义了一套精心设计的命令分类常量：

```typescript
// src/tools/BashTool/BashTool.tsx, Lines 54-81
PROGRESS_THRESHOLD_MS = 2000
BASH_SEARCH_COMMANDS  // Set: grep, find, rg, ag, fd, locate ...
BASH_READ_COMMANDS    // Set: cat, head, tail, less, more ...
BASH_LIST_COMMANDS    // Set: ls, tree, du, df, file ...
BASH_SEMANTIC_NEUTRAL_COMMANDS  // Set: echo, printf ...
BASH_SILENT_COMMANDS  // Set: cd, pwd ...
```

这五个分类构成了 BashTool 理解命令语义的基础。每一类命令具有不同的风险等级和行为特征：

**搜索命令**（BASH_SEARCH_COMMANDS）包括 `grep`、`find`、`rg` 等，它们只读取文件系统的元数据或内容，不产生副作用。**读取命令**（BASH_READ_COMMANDS）如 `cat`、`head`、`tail`，同样是只读操作。**列表命令**（BASH_LIST_COMMANDS）用于浏览目录结构。**语义中性命令**（BASH_SEMANTIC_NEUTRAL_COMMANDS）如 `echo`、`printf`，其行为完全取决于参数。**静默命令**（BASH_SILENT_COMMANDS）如 `cd`、`pwd`，几乎没有可观测的副作用。

```typescript
// src/tools/BashTool/BashTool.tsx, Lines 95-99
function isSearchOrReadBashCommand(command: string): boolean {
  // 判断命令是否属于搜索或读取类别
  // 用于决定是否需要权限检查
}
```

`isSearchOrReadBashCommand()` 函数是权限系统的第一道过滤器。如果一条命令被识别为纯粹的搜索或读取操作，它可以跳过某些权限检查环节，从而提供更流畅的使用体验。

`PROGRESS_THRESHOLD_MS` 设定为 2000 毫秒，这意味着执行时间超过 2 秒的命令会触发进度报告机制，让用户了解命令仍在执行中而非卡死。

## 10.2 输入参数与执行控制

BashTool 的输入参数设计反映了对各种使用场景的考量：

- **command**：要执行的 shell 命令，必填
- **timeout**：超时时间，可选，最大值 600000 毫秒（10 分钟）
- **description**：命令描述，帮助理解命令意图
- **run_in_background**：是否在后台执行
- **dangerouslyDisableSandbox**：危险选项，禁用沙箱

`run_in_background` 参数的存在解决了一个实际问题：某些命令（如启动开发服务器）需要长时间运行，如果同步等待会阻塞整个对话流程。后台执行模式允许命令在独立进程中运行，LLM 可以继续处理其他任务，稍后再检查结果。

超时机制是另一重要的安全保障。默认超时为 120 秒，最大允许 600 秒。超时后进程会被强制终止，防止失控命令无限期占用系统资源。

## 10.3 Bash AST 解析与安全分析

在命令被执行之前，BashTool 会对其进行语法层面的分析：

```
命令安全分析流程

BashTool.call({ command, timeout, description })
  |
  +-- Bash AST 解析 (src/utils/bash/ast.ts)
  |     +-- 解析命令为抽象语法树
  |     +-- 识别管道、重定向、子命令
  |     +-- 提取所有涉及的可执行文件名
  |
  +-- 命令拆分 (src/utils/bash/commands.ts)
  |     +-- 分离管道链中的各个命令
  |     +-- 识别 && 和 || 连接的命令序列
  |
  +-- 权限检查 (bashPermissions.ts)
  |     +-- 只读命令 -> 自动放行
  |     +-- 已授权命令 -> 放行
  |     +-- 未知命令 -> 请求用户授权
  |     +-- 危险命令 -> 拒绝或警告
  |
  +-- 进入执行阶段
```

`src/utils/bash/ast.ts` 实现了 Bash 命令的 AST（抽象语法树）解析。这不是简单的字符串分割——它能正确处理管道（`|`）、逻辑连接符（`&&`、`||`）、子 shell（`$(...)`)、重定向（`>`、`>>`）等复杂语法结构。

通过 AST 解析，系统可以从一条复合命令中提取出所有实际要执行的程序。比如对于 `find . -name "*.ts" | xargs grep "TODO" > output.txt` 这条命令，AST 分析会识别出三个关键元素：`find`（搜索命令）、`xargs`（需要进一步分析其参数）和 `grep`（搜索命令），以及一个文件重定向操作。

## 10.4 权限系统

权限检查的核心逻辑位于 `src/tools/BashTool/bashPermissions.ts`。这个模块决定一条命令是否需要用户的明确授权：

对于被分类为搜索或读取类型的命令，系统通常会自动放行，因为它们不会修改文件系统状态。而涉及写入、删除或系统管理的命令则需要经过权限审核。

权限系统还支持"记忆"机制——用户授权过一次的命令模式，在同一会话中不需要再次确认。这在重复执行类似命令时（比如多次运行测试套件）极大地改善了交互体验。

## 10.5 沙箱机制

沙箱是 BashTool 最核心的安全基础设施，其实现位于 `src/utils/sandbox/sandbox-adapter.ts`：

```
沙箱适配层

sandbox-adapter.ts
  |
  +-- 检测操作系统
  |
  +-- macOS 分支
  |     +-- 使用 sandbox-exec 系统调用
  |     +-- 加载预定义的沙箱配置文件
  |     +-- 限制文件系统访问范围
  |     +-- 限制网络访问能力
  |
  +-- Linux 分支
  |     +-- 使用 seccomp / namespace 隔离
  |     +-- 限制系统调用集合
  |     +-- 文件系统命名空间隔离
  |
  +-- dangerouslyDisableSandbox=true
        +-- 跳过所有沙箱限制
        +-- 以当前用户权限直接执行
```

在 macOS 上，沙箱利用了系统内置的 `sandbox-exec` 机制。这是 Apple 提供的应用沙箱技术，可以通过配置文件精确控制进程能够访问的文件路径、网络端口和系统调用。

在 Linux 上，沙箱采用了 seccomp（安全计算模式）和 namespace（命名空间）两种内核级隔离技术。seccomp 可以限制进程能使用的系统调用集合，而 namespace 则创建了一个隔离的文件系统视图，使得进程只能看到被允许的路径。

`dangerouslyDisableSandbox` 参数的命名用了 "dangerously" 前缀，这是一个经典的 API 设计策略——通过命名本身传达风险信号。在实际使用中，只有当沙箱限制干扰了合法操作（如需要访问特殊设备文件）时，才应该使用这个选项。

## 10.6 执行过程管理

命令通过权限检查和沙箱包装后，进入实际执行阶段。Shell 执行的核心封装位于 `src/utils/Shell.ts`：

```
进程生命周期

Shell.execute(command, options)
  |
  +-- 创建子进程 (child_process.spawn)
  +-- 注册 stdout/stderr 流处理器
  |     +-- 实时收集输出
  |     +-- 超过 PROGRESS_THRESHOLD_MS 时报告进度
  |
  +-- 等待进程结束
  |     +-- 正常退出 -> 收集 exitCode
  |     +-- 超时 -> 发送 SIGTERM, 等待, SIGKILL
  |     +-- 异常 -> 捕获错误信息
  |
  +-- 返回 { stdout, stderr, exitCode }
```

超时处理采用了两阶段终止策略：首先发送 SIGTERM 信号，给进程一个优雅退出的机会；如果进程在宽限期内没有响应，则发送 SIGKILL 强制终止。这种策略确保了即使遇到僵死进程，系统也不会被永久阻塞。

## 10.7 PowerShellTool

对于 Windows 平台，Claude Code 提供了 PowerShellTool 作为 BashTool 的对应物。它遵循与 BashTool 相同的安全模型——命令分类、权限检查、沙箱隔离——但底层使用 PowerShell 引擎执行命令。这种平台特化的设计确保了 Claude Code 在不同操作系统上都能提供一致的功能体验。

## 本章小结

BashTool 的设计展现了"最小权限原则"在实际工程中的应用。命令分类体系为自动化的权限决策提供了语义基础，AST 解析使得安全分析能够深入到命令的结构层面而非停留在表面的字符串匹配，多层沙箱机制则在操作系统内核层面构建了最后一道防线。这套安全体系的核心思想是：与其在出问题后补救，不如在执行前就确认操作的安全性。这也是 Claude Code 能够被授予 shell 访问权限的根本原因——不是因为信任 LLM 永远不会出错，而是因为即使出错，损害也被严格限制在可控范围内。
