# 第 17 章 权限与确认系统

> "Security is always excessive until it's not enough."
> —— Robbie Sinclair

一个能读写文件、执行 Shell 命令、发起网络请求的 AI 工具，如果缺乏有效的权限控制，就等于给用户的系统装了一扇没有锁的门。Claude Code 的权限系统是它安全模型的核心——每一次工具调用都要经过权限检查，任何可能产生副作用的操作都需要获得明确授权。本章将深入剖析这套权限体系的分层设计、规则匹配逻辑和用户确认流程。

## 17.1 权限系统的文件结构

权限相关的代码集中在 `src/utils/permissions/` 目录下，每个文件负责一个清晰的职责：

- **permissions.ts** —— 主入口，包含通用权限检查逻辑
- **PermissionMode.ts** —— 定义六种权限模式
- **PermissionResult.ts** —— 决策结果类型（允许、拒绝、需要询问）
- **PermissionRule.ts** —— 规则格式定义与匹配逻辑
- **filesystem.ts** —— 文件操作的专项权限检查
- **shellRuleMatching.ts** —— Bash 命令的模式匹配
- **denialTracking.ts** —— 记录被拒绝的操作
- **permissionRuleParser.ts** —— 解析 `.clauderc` 等配置文件中的规则

## 17.2 六种权限模式

`PermissionMode.ts` 定义了六种运行模式，从最严格到最宽松排列：

**plan 模式** —— 只读模式。所有写操作（文件编辑、Shell 命令、网络请求）一律被拒绝，模型只能读取文件和分析代码。适用于"先看看它会怎么做"的场景。

**dontAsk 模式** —— 静默拒绝。任何需要用户确认的操作都会被自动拒绝，不弹出确认提示。适用于自动化管道中不希望被交互式提示阻塞的场景。

**default 模式** —— 标准模式。读操作自动放行，写操作弹出确认提示。这是绝大多数用户日常使用的模式。

**acceptEdits 模式** —— 自动接受文件编辑，但其他写操作（如 Shell 命令）仍然需要确认。适用于信任模型的编辑能力、但对命令执行保持谨慎的场景。

**bypassPermissions 模式** —— 跳过所有权限检查，一切操作自动放行。这是一个危险模式，仅在用户明确知晓风险的前提下启用。

**auto 模式** —— 基于分类器（classifier）自动判断。这是一个实验性模式，仅在启用了 `TRANSCRIPT_CLASSIFIER` 特性开关时可用：

```typescript
// src/utils/permissions/permissions.ts:59-64
const classifierDecisionModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('./classifierDecision.js') as typeof import('./classifierDecision.js'))
  : null
```

auto 模式使用一个独立的分类模型来评估每次操作的风险等级，然后自动做出允许或拒绝的决策。这种方式的目标是在安全性和便利性之间找到更优的平衡点——高风险操作仍然会被拦截，低风险操作则无需用户手动确认。

## 17.3 权限规则与匹配

除了模式级别的控制，用户还可以定义细粒度的权限规则。规则分为三类：`alwaysAllow`（始终允许）、`alwaysDeny`（始终拒绝）和 `alwaysAsk`（始终询问）。这些规则通过 `ToolPermissionContext` 传递给权限检查逻辑：

```typescript
// src/tools/Tool.ts:123-138
type ToolPermissionContext = DeepImmutable<{
  mode: PermissionMode
  additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory>
  alwaysAllowRules: ToolPermissionRulesBySource
  alwaysDenyRules: ToolPermissionRulesBySource
  alwaysAskRules: ToolPermissionRulesBySource
  isBypassPermissionsModeAvailable: boolean
}>
```

`ToolPermissionRulesBySource` 的 "BySource" 后缀意味着规则带有来源信息——是来自全局配置、项目配置还是 MDM 企业策略。这个来源信息在规则冲突时用于确定优先级。

规则匹配的过程因工具类型而异。文件操作的规则匹配在 `filesystem.ts` 中实现，需要处理路径通配符、目录递归匹配等文件系统特有的逻辑。Shell 命令的规则匹配在 `shellRuleMatching.ts` 中实现，需要解析命令字符串、识别管道和重定向，确保用户编写的 `allow: "git *"` 规则不会意外匹配到 `git push --force`（如果用户不希望的话）。

`permissionRuleParser.ts` 负责从 `.clauderc` 和其他配置文件中解析规则定义。规则格式需要在表达力和简洁性之间取得平衡——太简单则无法覆盖复杂场景，太复杂则用户不愿意写。

## 17.4 权限检查的完整流程

当一个工具准备执行时，权限检查经历多个层次的过滤：

```
工具请求执行
  |
  v
validateInput() -- 输入合法性校验
  |
  +-- 不合法 --> 直接拒绝，返回错误信息
  |
  +-- 合法 --> 继续
        |
        v
  checkPermissions() -- 工具自身的权限逻辑
        |
        +-- 'allow' --> 直接放行，执行工具
        |
        +-- 'deny' --> 直接拒绝
        |
        +-- 'passthrough' --> 进入通用权限检查
              |
              v
        匹配 alwaysAllow 规则
              |
              +-- 命中 --> 放行
              |
              +-- 未命中 --> 继续
                    |
                    v
              匹配 alwaysDeny 规则
                    |
                    +-- 命中 --> 拒绝
                    |
                    +-- 未命中 --> 继续
                          |
                          v
                    检查 PermissionMode
                          |
                          +-- bypassPermissions --> 放行
                          +-- dontAsk --> 拒绝
                          +-- plan（且是写操作）--> 拒绝
                          +-- auto --> 调用分类器决策
                          +-- default/acceptEdits --> 弹出确认提示
                                |
                                v
                          用户确认
                                |
                                +-- 允许 --> 执行
                                +-- 允许并记住 --> 添加到 alwaysAllow，执行
                                +-- 拒绝 --> 记录到 denialTracking
```

这个流程的设计体现了"快速路径优先"的原则。最常见的情况——用户已经配置了 alwaysAllow 规则的操作——在流程的最前端就被放行，不需要经过后续的模式检查和用户确认。只有真正需要决策的操作才会走到流程末端。

## 17.5 工具级权限钩子

每个工具都可以实现自己的 `checkPermissions` 方法，在通用权限检查之前执行自定义逻辑。这个钩子返回三种结果之一：

- `allow` —— 工具自行判定操作安全，跳过通用检查
- `deny` —— 工具自行判定操作危险，直接拒绝
- `passthrough` —— 工具不做判定，交给通用权限逻辑处理

举例来说，Read 工具（读取文件）在大多数模式下直接返回 `allow`，因为读取操作通常不需要确认。而 Bash 工具则需要分析命令内容——如果命令是 `ls` 或 `cat` 之类的纯读取操作，可以提前放行；如果是 `rm` 或 `chmod`，则需要通用权限流程来决策。

## 17.6 拒绝追踪

`denialTracking.ts` 记录了所有被用户拒绝的操作。这份记录有两个用途。第一，避免重复打扰——如果用户刚刚拒绝了某个操作，模型在短时间内再次尝试同样的操作时，系统可以直接拒绝而不再弹出确认框。第二，为模型提供反馈——拒绝记录会被包含在工具执行结果中，告诉模型"用户不希望执行这个操作"，帮助模型调整后续策略。

这个机制解决了一个实际问题：没有拒绝追踪时，模型可能会反复尝试被用户拒绝的操作，每次都弹出确认框，造成糟糕的用户体验。有了追踪之后，一次拒绝就足以让模型理解用户意图。

## 17.7 文件系统的特殊处理

文件操作的权限检查比其他工具更为复杂，因为需要考虑路径的层级关系。`filesystem.ts` 处理了以下问题：

工作目录约束——默认情况下，文件操作只允许在项目的工作目录及其子目录中执行。`additionalWorkingDirectories` 配置允许用户扩展可操作的目录范围。

路径规范化——用户可能输入相对路径、包含 `..` 的路径、符号链接路径，这些都需要解析为绝对路径后再与规则匹配，防止通过路径变体绕过权限限制。

## 本章小结

Claude Code 的权限系统采用了多层防御策略。六种权限模式从全局层面控制操作许可范围，三类规则（alwaysAllow、alwaysDeny、alwaysAsk）提供细粒度的操作级控制，每个工具的 `checkPermissions` 钩子处理工具特有的安全逻辑。权限检查流程按"快速路径优先"原则设计——最常见的操作在最少的步骤内完成决策。拒绝追踪机制避免模型重复尝试被用户否决的操作。整套体系的核心设计意图很明确：在确保安全的前提下，尽可能减少对用户工作流的打断。
