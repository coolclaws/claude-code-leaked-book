# 第 20 章 记忆与会话

> "The palest ink is better than the best memory."
> — Chinese Proverb

大语言模型的一个根本局限是无状态性——每次对话开始时，模型对你一无所知。Claude Code 的记忆系统正是为了弥补这个缺陷：它在会话之间持久化用户偏好、项目上下文、过往决策，让模型在每次启动时就像一个了解你的同事，而非一个陌生人。

本章将分析记忆的存储结构、加载与截断机制、会话持久化策略，以及 Compact 系统如何在长对话中管理上下文窗口。

## 20.1 记忆目录结构

记忆系统的核心实现位于 `src/memdir/` 目录。`memdir` 这个名字暗示了其设计——memory directory，将记忆组织为目录中的文件集合，而非单一的数据库或 JSON 文件。

每个项目的记忆存储在 `~/.claude/projects/{project}/memory/` 目录下，内部结构如下：

```
~/.claude/projects/my-app/memory/
  |
  +-- MEMORY.md              # 入口文件（索引）
  +-- user-preferences.md    # 用户偏好
  +-- coding-style.md        # 代码风格
  +-- project-goals.md       # 项目目标
  +-- api-patterns.md        # API 设计模式
  +-- ...                    # 更多记忆文件
```

每个记忆文件都是独立的 Markdown 文件，带有 frontmatter 元数据：

```markdown
---
name: coding-style
description: Preferred coding conventions for this project
type: feedback
---

- Use functional components with hooks, not class components
- Prefer named exports over default exports
- Error messages should include the function name and parameter values
```

`MEMORY.md` 是整个记忆系统的入口点，其文件名定义在 `src/memdir/memdir.ts` 中：

```typescript
// src/memdir/memdir.ts:34-36
const ENTRYPOINT_NAME = 'MEMORY.md'
const MAX_ENTRYPOINT_LINES = 200
const MAX_ENTRYPOINT_BYTES = 25_000
```

这三个常量定义了记忆系统的硬性边界：入口文件最多 200 行或 25KB，二者取其小。这个限制背后的考量是模型上下文窗口的预算管理——记忆内容会注入系统提示词，占用的 token 越多，留给实际对话的空间就越少。

## 20.2 记忆类型体系

`src/memdir/memoryTypes.ts` 定义了四种记忆类型，每种针对不同类别的信息：

**user 类型**：记录用户的角色、偏好和知识背景。例如"我是后端工程师，偏好 TypeScript"、"我使用 Vim 键位绑定"。这类信息帮助模型调整沟通风格和技术假设。

**feedback 类型**：记录用户的修正和确认。当用户纠正模型的某个行为时——"不要用 any 类型"、"测试文件放在 __tests__ 目录"——这些修正被持久化为 feedback 记忆，避免同一错误反复出现。

**project 类型**：记录项目的进行中工作、目标和截止日期。例如"正在重构认证模块，目标是 Q2 完成"、"v2.0 API 需要向后兼容 v1.x"。这类信息提供了宏观的项目上下文。

**reference 类型**：记录外部系统的指针和参考。例如"API 文档在 https://docs.example.com"、"CI/CD 配置参见 .github/workflows/"。这类记忆不包含实际内容，而是告诉模型在哪里可以找到更多信息。

这四种类型的划分不仅是分类学上的整理，更影响了记忆的检索权重——当上下文空间有限时，系统可以根据当前任务优先加载相关类型的记忆。

## 20.3 入口文件截断策略

当 `MEMORY.md` 的内容超过限制时，截断逻辑确保加载的内容仍然有意义：

```typescript
// src/memdir/memdir.ts:41-47
type EntrypointTruncation = {
  content: string
  wasLineTruncated: boolean
  wasByteTruncated: boolean
  originalLineCount: number
  originalByteCount: number
}
```

```typescript
// src/memdir/memdir.ts:57-76
export function truncateEntrypointContent(
  raw: string
): EntrypointTruncation {
  const trimmed = raw.trim()
  const contentLines = trimmed.split('\n')
  const wasLineTruncated =
    contentLines.length > MAX_ENTRYPOINT_LINES
  const wasByteTruncated =
    trimmed.length > MAX_ENTRYPOINT_BYTES
  // 先按行数截断，再按字节截断
  // 返回截断后的内容和截断元信息
}
```

截断采用双重策略：先检查行数是否超过 200 行，再检查字节数是否超过 25,000。`EntrypointTruncation` 结构体不仅返回截断后的内容，还携带了截断的元信息——这些信息可以用于向模型提示"记忆已被截断，可能遗漏了部分内容"，让模型在需要时主动查询完整记忆。

## 20.4 记忆加载流程

`loadMemoryPrompt()` 是记忆注入系统提示词的入口函数。完整流程如下：

```
会话启动
  |
  +-- loadMemoryPrompt()
  |     |
  |     +-- 确定项目标识（路径哈希）
  |     +-- 定位记忆目录
  |     |     ~/.claude/projects/{project-hash}/memory/
  |     |
  |     +-- 查找 MEMORY.md
  |     |     +-- 不存在？→ 返回空（无记忆状态）
  |     |     +-- 存在？→ 读取内容
  |     |
  |     +-- truncateEntrypointContent()
  |     |     +-- 行数 > 200？→ 截断
  |     |     +-- 字节 > 25KB？→ 截断
  |     |
  |     +-- 构建记忆提示词段落
  |     +-- 注入系统提示词
  |
  +-- findRelevantMemories()（可选）
        +-- 基于当前对话语义搜索相关记忆
        +-- 补充入口文件未涵盖的细节
```

`src/memdir/findRelevantMemories.ts` 提供了语义层面的记忆检索。当入口文件因截断而遗漏了某些记忆时，系统可以根据当前对话的主题动态检索相关的记忆文件。`src/memdir/memoryScan.ts` 负责底层的文件发现——扫描记忆目录中的所有 `.md` 文件，解析元数据建立索引。

路径解析由 `src/memdir/paths.ts` 处理，它区分了两种模式：自动记忆（auto-memory）和用户记忆（user memory）。自动记忆是系统自动提取和保存的信息，用户记忆是用户通过 `/memory` 命令主动管理的内容。

## 20.5 会话持久化

记忆系统关注的是跨会话的长期信息，而会话持久化关注的是单次会话的完整记录。相关实现分布在三个位置：

- `src/services/SessionMemory/sessionMemory.ts`：会话级记忆管理，跟踪当前会话中积累的上下文
- `src/history.ts`：会话历史的加载与保存，包括完整的对话记录
- `src/utils/session/sessionStorage.ts`：底层存储抽象，处理对话记录和元数据的序列化与持久化

会话记录的保存策略是增量式的——每个 assistant 消息完成后立即追加到存储中，而非等到会话结束时一次性写入。这确保了即使 Claude Code 意外退出，对话历史也不会丢失。

## 20.6 Compact 系统：上下文窗口管理

长时间对话的一个实际问题是上下文窗口耗尽。当对话历史加上系统提示词接近模型的上下文限制时，要么截断历史（丢失信息），要么压缩历史（保留要点）。Claude Code 选择了后者，实现为 Compact 系统。

核心实现位于两个文件：

- `src/services/compact/compact.ts`：压缩逻辑的主体实现
- `src/services/compact/autoCompact.ts`：自动触发条件判断

Compact 的工作原理是让模型自己总结已有的对话历史，生成一个浓缩版本替代原始消息。这不是简单的文本截断，而是语义级的压缩——模型会保留关键决策、重要发现、待完成的任务，同时丢弃冗余的中间推理过程。

```
对话进行中
  |
  +-- autoCompact 监控上下文使用率
  |     +-- 使用率 < 阈值？→ 继续
  |     +-- 使用率 >= 阈值？→ 触发压缩
  |
  +-- compact() 执行
  |     |
  |     +-- 收集当前对话历史
  |     +-- 构建压缩提示词
  |     |     "请总结以下对话的关键信息..."
  |     |
  |     +-- 模型生成摘要
  |     +-- 替换原始消息为摘要
  |     +-- 释放上下文空间
  |
  +-- CompactTool（手动触发）
        +-- 用户主动调用 /compact
        +-- 执行相同的压缩流程
```

CompactTool 是压缩功能面向模型和用户的接口。用户可以在任何时候输入 `/compact` 手动触发压缩；模型也可以在感觉上下文过长时主动调用 CompactTool。自动压缩（autoCompact）则在后台静默运行，当检测到上下文使用率超过阈值时自动介入。

Compact 的一个微妙之处在于：压缩本身也消耗上下文——模型需要读取完整历史才能生成摘要。因此自动压缩的触发时机不能太晚，需要预留足够的空间完成压缩操作本身。

## 本章小结

记忆与会话系统构成了 Claude Code 的"长期记忆"和"短期记忆"。`MEMORY.md` 入口文件配合 200 行 / 25KB 的截断策略，在信息量和上下文成本之间取得平衡；四种记忆类型（user、feedback、project、reference）覆盖了开发者日常工作中需要持久化的各类知识；语义检索补充了截断带来的信息损失；会话持久化通过增量写入保障了数据安全；Compact 系统则通过语义压缩让长时间对话成为可能。这些机制协同工作，让一个无状态的语言模型表现得像一个有记忆的合作伙伴。
