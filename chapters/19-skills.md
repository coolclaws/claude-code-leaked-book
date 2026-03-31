# 第 19 章 Skills 系统

> "Tell me and I forget, teach me and I may remember, involve me and I learn."
> — Benjamin Franklin

Claude Code 的工具系统解决了"能做什么"的问题，而 Skills 系统解决的是"怎么做"的问题。一个 Skill 本质上是一段预定义的指令——它告诉模型在特定场景下应该遵循怎样的流程、使用哪些工具、注意哪些约束。如果说工具是手术刀，那么 Skill 就是手术方案。

本章将剖析 Skills 的定义格式、发现机制、执行流程，以及它与 MCP prompts 的集成方式。

## 19.1 Skill 的定义格式

Skill 采用 Markdown 文件作为载体，通过 YAML frontmatter 提供元数据。这个设计选择既让 Skill 易于编写和版本控制，又保留了结构化元数据的能力：

```markdown
---
name: deploy-staging
description: Deploy current branch to staging environment
---

## Steps

1. Run tests to ensure all pass
2. Build the project with staging configuration
3. Deploy to staging server using the deploy script
4. Verify deployment health check endpoint

## Notes

- Always check git status before deploying
- Never deploy uncommitted changes
```

frontmatter 中的 `name` 字段决定了 Skill 的调用名称——用户输入 `/deploy-staging` 或模型通过 SkillTool 传入该名称即可触发。`description` 提供一句话描述，用于搜索匹配和用户提示。

Markdown 正文部分就是注入给模型的指令内容。这里没有特殊的模板语法或变量替换——纯粹的自然语言指令。模型收到这些指令后，会像执行用户请求一样遵循其中的步骤。这种"指令即代码"的设计极其简洁，任何能写 Markdown 的人都能创建 Skill。

## 19.2 Skill 的四个来源

Skills 可以从四个来源加载，优先级和适用范围各不相同：

```
Skill 来源与优先级
+------------------------------------------------------+
|  来源          | 路径                    | 适用范围   |
|----------------|-------------------------|------------|
|  Bundled       | src/skills/bundled/     | 全局内置   |
|  User          | ~/.claude/skills/       | 用户级     |
|  Project       | .claude/skills/         | 项目级     |
|  MCP Prompts   | MCP 服务器动态提供      | 动态       |
+------------------------------------------------------+
```

**Bundled Skills** 是随 Claude Code 一起发布的内置技能。它们位于 `src/skills/bundled/` 目录下，覆盖了最常见的开发场景——代码审查、提交规范、测试策略等。这些 Skill 经过精心调优，代表了 Anthropic 团队认为的最佳实践。

**User Skills** 存放在 `~/.claude/skills/` 目录，是用户个人的技能库。它们跨项目生效，适合存放与个人工作习惯相关的通用技能——比如特定的代码风格偏好、常用的调试流程等。

**Project Skills** 位于项目根目录的 `.claude/skills/` 下，随项目代码一起版本控制。团队成员共享同一套项目级 Skill，确保一致的工作流程。这是团队知识沉淀的理想场所——部署流程、代码规范、架构决策等都可以编码为 Skill。

**MCP Prompt Skills** 是最动态的一种来源。MCP 服务器除了暴露工具和资源外，还可以暴露 prompts。`src/skills/mcpSkillBuilders.ts` 负责将 MCP prompts 转换为标准的 Skill 格式，使它们在用户体验上与本地 Skill 无异。

## 19.3 Skill 发现与加载

Skill 的发现过程由 `src/skills/loadSkillsDir.ts` 驱动，这个约 34KB 的文件实现了两个核心函数。

`discoverSkillDirsForPaths()` 负责扫描指定路径下的 Skill 目录。它会递归遍历目录结构，找到所有 `.md` 文件，解析 frontmatter 提取元数据，建立名称到文件路径的映射。

`activateConditionalSkillsForPaths()` 处理条件激活逻辑。并非所有发现的 Skill 都会立即可用——某些 Skill 可能附带激活条件，例如仅在特定编程语言的项目中生效，或仅在检测到特定配置文件时激活。这种条件机制避免了工具列表的无限膨胀：一个 Python 项目不需要看到 Rust 专用的 Skill。

搜索能力由 `src/services/skillSearch/localSearch.ts` 提供。当 Skill 数量较多时，用户可能不记得确切的名称，搜索功能允许通过关键词模糊匹配。值得注意的是，高级搜索发现功能由特性门控 `EXPERIMENTAL_SKILL_SEARCH` 控制，这意味着该功能仍处于实验阶段，未来可能引入语义搜索等更智能的匹配算法。

## 19.4 SkillTool：执行入口

SkillTool（`src/tools/SkillTool/SkillTool.ts`）是 Skill 系统面向模型的接口。它的设计非常直接——接收 Skill 名称和可选参数，返回 Skill 的执行结果。

```
用户输入 "/deploy-staging" 或模型调用 SkillTool
  |
  +-- 解析 Skill 名称
  |
  +-- 查找 Skill 定义
  |     |
  |     +-- 1. 检查 Bundled Skills
  |     |     +-- 命中？→ 加载 Skill 内容
  |     |
  |     +-- 2. 检查 Project Skills (.claude/skills/)
  |     |     +-- 命中？→ 加载 Skill 内容
  |     |
  |     +-- 3. 检查 User Skills (~/.claude/skills/)
  |     |     +-- 命中？→ 加载 Skill 内容
  |     |
  |     +-- 4. 检查 MCP Prompt Skills
  |     |     +-- 命中？→ 从 MCP 服务器获取 prompt 内容
  |     |
  |     +-- 未找到？→ 返回错误
  |
  +-- 解析 Markdown 文件
  |     +-- 提取 frontmatter 元数据
  |     +-- 提取正文内容
  |
  +-- 将 Skill 内容注入对话
  |     +-- 作为系统级指令插入
  |     +-- 模型在后续响应中遵循指令
  |
  +-- 模型根据 Skill 指令执行操作
        +-- 调用相关工具（Bash, FileWrite 等）
        +-- 遵循 Skill 中定义的步骤和约束
```

Skill 的执行并不像普通工具那样有明确的"返回值"。Skill 的效果是改变了模型的行为模式——注入的指令成为模型后续推理的上下文。这是一种元工具（meta-tool）的设计：它不直接产生输出，而是影响其他工具的使用方式。

## 19.5 与命令系统的集成

Skills 与 Claude Code 的斜杠命令系统深度集成。在 `commands.ts` 中，`getSlashCommandToolSkills` 函数将所有可用的 Skill 注册为斜杠命令。这意味着用户在输入 `/` 时，会看到一个包含内置命令和 Skill 的统一列表，二者的使用体验完全一致。

这种集成的巧妙之处在于：用户不需要知道某个命令是"内置"的还是"Skill 提供"的。`/commit` 可能是内置命令，`/deploy-staging` 可能是项目 Skill，`/review-pr` 可能来自 MCP 服务器——在用户看来它们都是同等的能力。

同时，这也意味着 Skill 的命名空间与内置命令共享。如果一个 Skill 的名称与内置命令冲突，内置命令优先。这是一个合理的默认策略——防止用户或第三方 Skill 意外覆盖核心功能。

## 19.6 设计考量：为什么是 Markdown

选择 Markdown 作为 Skill 格式而非 JSON、YAML 或自定义 DSL，背后有几个关键考虑。

首先是可读性。Skill 的主体是给模型的自然语言指令，Markdown 本身就是为可读的结构化文本而设计的。在 Markdown 文件中编写给模型的指令，读起来就像在写一封给同事的工作说明。

其次是工具链兼容性。Markdown 文件可以在任何编辑器中编辑、在 GitHub 上直接渲染、在 PR review 中清晰展示。团队成员审查一个新的 Skill 就像审查一份文档，门槛极低。

最后是扩展性。frontmatter 提供了结构化元数据的扩展点，未来可以轻松添加新的元数据字段（如 `requires`、`version`、`tags`）而无需改变文件格式。

## 本章小结

Skills 系统为 Claude Code 提供了一种轻量级的行为编程机制。通过 Markdown 文件定义指令、四层来源覆盖从内置到动态的全部场景、SkillTool 作为统一的执行入口、与斜杠命令系统的无缝集成——这些组合构成了一个让用户和团队能够持续积累和共享工作流知识的框架。Skill 的本质不是代码，而是经验的编码化：将"怎么做"变成可复用、可版本控制、可共享的资产。
