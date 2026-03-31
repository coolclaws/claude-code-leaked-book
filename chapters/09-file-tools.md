# 第 9 章 文件操作工具

> "程序的本质是对数据的变换，而文件是数据最持久的栖息地。" —— Rob Pike

Claude Code 作为一个代码助手，其核心能力之一就是对文件系统的操作。本章将深入分析三个文件操作工具——FileReadTool、FileWriteTool 和 FileEditTool——的实现原理，揭示它们如何在保证安全性的前提下，提供强大而灵活的文件处理能力。

## 9.1 FileReadTool：万能的文件读取器

FileReadTool 的实现位于 `src/tools/FileReadTool/FileReadTool.ts`，它的职责远不止读取纯文本文件那么简单。

```typescript
// src/tools/FileReadTool/FileReadTool.ts, Lines 1-4
import { Base64ImageSource } from '...'
import { readdir, readFile } from 'fs/promises'
import path from 'path'
```

从导入列表可以看出，这个工具从一开始就被设计为支持多种文件格式——不仅包括文本文件，还涵盖图片和目录浏览。

### 输入参数设计

FileReadTool 接受以下输入参数：

- **file_path**：文件的绝对路径，这是唯一的必填参数
- **pages**：针对 PDF 文件的页码范围（如 `"1-5"`）
- **limit**：读取的最大行数
- **offset**：从第几行开始读取

`limit` 和 `offset` 的组合使得工具可以精确地读取大文件的某一段落，避免一次性加载整个文件造成内存压力。

### 安全边界：设备路径屏蔽

```typescript
// src/tools/FileReadTool/FileReadTool.ts, Lines 98-100
const BLOCKED_DEVICE_PATHS = new Set(['/dev/zero', '/dev/random', '/dev/urandom', ...])
```

这个集合定义了被禁止读取的设备路径。想象一下如果 LLM 尝试读取 `/dev/zero`——一个永远返回零字节的无限流——后果将是灾难性的：进程会陷入无限读取，内存迅速耗尽。通过在入口处设置黑名单，这类问题被彻底杜绝。

### 多格式支持矩阵

FileReadTool 支持超过 100 种文件类型，其处理逻辑可以归纳为以下流程：

```
FileReadTool.call({ file_path, pages, limit, offset })
  |
  +-- 检查路径是否在 BLOCKED_DEVICE_PATHS 中
  |     +-- 是 -> 拒绝并返回错误
  |
  +-- 判断文件类型
  |     +-- PDF 文件 -> 按页码范围提取文本
  |     +-- 图片文件 -> 缩放后转 Base64 编码
  |     +-- Notebook (.ipynb) -> 解析 JSON 结构
  |     +-- 目录路径 -> 调用 readdir 列出内容
  |     +-- 其他文本 -> 直接读取内容
  |
  +-- 应用 offset 和 limit 截取
  +-- 返回格式化结果
```

对于 Jupyter Notebook 的支持值得特别关注。`.ipynb` 文件本质上是一个 JSON 文件，包含多个 cell，每个 cell 有自己的类型（code、markdown）和输出。FileReadTool 会解析这个 JSON 结构，将所有 cell 的内容和输出按顺序组装成可读的文本表示，使 LLM 能够理解 Notebook 的完整上下文。

图片文件则经过缩放处理后转为 Base64 编码返回，利用了多模态 LLM 的视觉理解能力。

## 9.2 FileWriteTool：带历史追踪的写入器

FileWriteTool 位于 `src/tools/FileWriteTool/FileWriteTool.ts`，负责文件的创建和完整覆写。

### 输入与输出的精心设计

```typescript
// src/tools/FileWriteTool/FileWriteTool.ts, Lines 56-65
const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z.string().describe('The absolute path to the file to write...'),
    content: z.string().describe('The content to write to the file'),
  }),
)
```

输入看似简单——只需路径和内容。但真正的设计巧思体现在输出结构上：

```typescript
// src/tools/FileWriteTool/FileWriteTool.ts, Lines 68-88
// 输出包含：
//   type: 'create' | 'update'   -- 操作类型
//   structuredPatch              -- 结构化补丁
//   originalFile                 -- 原始文件内容
//   gitDiff                      -- Git 格式的差异
```

这个输出结构揭示了一个重要的设计决策：每次写入都不是简单的"覆盖"，而是一次有完整记录的变更操作。系统会区分"创建新文件"和"更新已有文件"两种场景，并在更新时生成完整的 diff 信息。

```typescript
// src/tools/FileWriteTool/FileWriteTool.ts, Lines 94-100
// buildTool 定义，工具名称为 FILE_WRITE_TOOL_NAME
```

这种设计使得文件写入操作具备了完整的可追溯性。当 LLM 在一次会话中对同一文件进行多次修改时，每次修改的前后对比都被忠实记录，为后续的审查和回滚提供了基础。

## 9.3 FileEditTool：精确的字符串替换引擎

FileEditTool 是三个文件工具中最精巧的一个，位于 `src/tools/FileEditTool/FileEditTool.ts`。它实现了一种基于"精确字符串匹配"的编辑策略，而非传统的行号定位方式。

### 容量限制

```typescript
// src/tools/FileEditTool/FileEditTool.ts, Line 84
const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024  // 1 GiB
```

1 GiB 的上限设置得相当宽裕，意味着该工具几乎可以处理任何合理大小的源代码文件。这个值的选择是对"实用性"和"安全性"的平衡——足够大以覆盖所有正常场景，又不至于让系统因处理巨型文件而崩溃。

### 字符串替换算法

FileEditTool 的核心是 `old_string -> new_string` 的替换机制，其工作流程如下：

```
FileEditTool.call({ file_path, old_string, new_string, replace_all })
  |
  +-- 读取当前文件内容
  |
  +-- 验证 old_string
  |     +-- 文件中不存在 -> 返回错误
  |     +-- 出现多次且 replace_all=false -> 返回错误（唯一性检查）
  |     +-- 出现一次或 replace_all=true -> 继续
  |
  +-- 执行字符串替换
  |     +-- replace_all=false -> 替换首次出现
  |     +-- replace_all=true  -> 替换所有出现
  |
  +-- 写入新内容到文件
  +-- 生成 structuredPatch + gitDiff
  +-- 更新文件状态缓存
  +-- 返回包含 diff 的结果
```

唯一性检查是这个算法的关键创新点。当 `replace_all` 为 `false` 时（这是默认行为），工具要求 `old_string` 在文件中只出现一次。如果出现多次，操作会被拒绝，并要求调用方提供更多上下文以消除歧义。

这种设计比基于行号的编辑方式有明显优势。行号是脆弱的——在多步编辑过程中，前一步的修改会导致后续步骤的行号发生偏移。而字符串匹配是基于内容的，只要目标文本没有被修改过，它就能被准确定位。

### replace_all：批量替换模式

当 `replace_all` 设置为 `true` 时，工具会替换文件中所有匹配的 `old_string`。这在变量重命名等场景下非常实用——一个函数名可能在文件中出现数十次，逐一替换既低效又容易遗漏。

```typescript
// src/tools/FileEditTool/FileEditTool.ts, Lines 86-100
// buildTool 定义
// FILE_EDIT_TOOL_NAME
// searchHint: 'modify file contents in place'
```

`searchHint` 属性告诉工具路由系统，当 LLM 想要"就地修改文件内容"时，应该优先考虑这个工具。

## 9.4 三个工具的协作模式

三个文件工具在实际使用中形成了清晰的分工：

```
用户请求："修改 config.ts 中的端口号"
  |
  +-- FileReadTool: 读取 config.ts 的当前内容
  |     返回: 文件内容 + 行号标注
  |
  +-- FileEditTool: 定位并替换端口号
  |     输入: old_string="port: 3000", new_string="port: 8080"
  |     返回: 结构化 diff
  |
  +-- (若需完全重写) FileWriteTool: 写入全新内容
        返回: 完整 diff + 操作类型
```

FileReadTool 是信息收集者，FileEditTool 是精准修改者，FileWriteTool 是完整重写者。LLM 会根据修改的范围和复杂度自动选择合适的工具——小范围修改用 EditTool，大范围重写用 WriteTool。

## 9.5 结构化补丁输出

三个工具在产生修改时都会输出结构化补丁（structuredPatch）和 Git diff 格式的差异。这不仅仅是为了美观的展示——这些信息会被回传给 LLM，帮助它确认修改是否正确，并为后续的编辑操作提供最新的文件状态。

这种"操作即反馈"的设计构成了一个闭环：LLM 发出编辑指令，工具执行后返回精确的变更报告，LLM 据此判断下一步操作。

## 本章小结

Claude Code 的文件操作工具体系体现了几个核心设计原则。安全优先，从设备路径屏蔽到文件大小限制，每一层都有防护措施。精确可控，FileEditTool 的字符串唯一性检查确保每次编辑都指向明确的目标。可追溯，每次修改都生成完整的 diff 记录，支持审查和回滚。格式感知，从 PDF 到 Notebook 到图片，工具链能够理解并处理开发者日常接触的各种文件格式。这些工具共同构成了 Claude Code 与文件系统交互的基础层，后续章节将讨论的 Shell 工具和搜索工具则在此基础上进一步扩展了系统的能力边界。
