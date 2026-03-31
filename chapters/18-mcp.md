# 第 18 章 MCP 集成

> "Any sufficiently advanced technology is indistinguishable from magic."
> — Arthur C. Clarke

如果 Tool System 定义了 Claude Code 的内置能力边界，那么 MCP（Model Context Protocol）就是打破这个边界的桥梁。通过 MCP，Claude Code 可以连接到任意外部工具服务器——数据库查询、API 调用、自定义业务逻辑——而无需修改自身一行代码。MCP 的设计哲学是：让工具的供给侧和消费侧彻底解耦。

本章将深入分析 MCP 的传输层、配置管理、认证流程、以及 MCPTool 如何将外部工具无缝嵌入 Claude Code 的工具体系。

## 18.1 MCP 协议与传输层

MCP 基于 `@modelcontextprotocol/sdk`（版本 ^1.12.1）构建，其核心思想是将工具服务器抽象为一个标准化的协议端点。客户端通过协议发现服务器提供的工具、资源和提示词（prompts），然后按需调用。

传输层的实现位于 `src/services/mcp/client.ts`，文件开头就明确导入了所有支持的传输类型：

```typescript
// src/services/mcp/client.ts:1-21
import { Client } from '@modelcontextprotocol/sdk/client'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/transport/sse'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/transport/stdio'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/transport/http'
```

Claude Code 支持五种传输方式，每种适用于不同的部署场景：

- **stdio**：最常见的本地模式。MCP 服务器作为子进程启动，通过标准输入输出通信。适合本地开发工具、文件系统扩展。
- **sse**：Server-Sent Events，基于 HTTP 的单向流式传输。适合远程服务器场景，服务端可以主动推送事件。
- **http**：基于 HTTP 的请求-响应模式，使用 StreamableHTTPClientTransport 实现。适合无状态的远程 API 服务。
- **ws**：WebSocket 传输，提供全双工通信。适合需要高频双向交互的场景。
- **sdk**：直接通过 SDK 内嵌方式连接，跳过网络层。适合同进程内的工具集成。

传输层的选择对用户是透明的——配置文件中指定传输类型，客户端自动创建对应的 Transport 实例。

## 18.2 配置的七层作用域

MCP 的配置管理位于 `src/services/mcp/config.ts`，其复杂度远超一般的配置系统。Claude Code 定义了七个配置作用域，按优先级从低到高排列：

```
配置作用域优先级（低 → 高）
+--------------------------------------------------+
| enterprise    | 企业级配置，管理员统一下发        |
| managed       | 托管平台配置                      |
| claudeai      | Claude AI 平台配置                |
| user          | 用户级 (~/.claude/mcp.json)       |
| project       | 项目级 (.claude/mcp.json)         |
| local         | 本地级 (.mcp.json，项目根目录)    |
| dynamic       | 运行时动态注册                    |
+--------------------------------------------------+
```

每个作用域对应一个配置文件或配置源。类型定义在 `src/services/mcp/types.ts` 中清晰地反映了这种分层：

```typescript
// src/services/mcp/types.ts (核心类型)
type ConfigScope = 'local' | 'user' | 'project' | 'dynamic'
                 | 'enterprise' | 'claudeai' | 'managed'

interface McpServerConfig {
  command?: string          // stdio 模式的启动命令
  args?: string[]           // 命令参数
  env?: Record<string, string>  // 环境变量
  transport?: Transport     // 传输类型
  url?: string              // 远程服务器地址
}

interface ScopedMcpServerConfig extends McpServerConfig {
  scope: ConfigScope
}
```

为什么需要这么多层？考虑一个企业级场景：IT 管理员通过 enterprise 作用域强制所有开发者连接公司内部的代码审查 MCP 服务器；团队通过 project 作用域配置共享的数据库查询工具；开发者个人通过 local 作用域添加自己常用的调试工具。各层互不干扰，高优先级覆盖低优先级的同名配置。

`.mcp.json`（local 作用域）是最常见的配置入口，位于项目根目录，通常被加入版本控制以便团队共享。

## 18.3 认证：从 OAuth 到跨应用访问

当 MCP 服务器需要认证时，事情变得有趣。`src/services/mcp/auth.ts` 实现了完整的认证流程，包括两种主要模式。

第一种是标准的 OAuth 认证流程——每个 MCP 服务器可以独立配置自己的 OAuth 端点。当用户首次连接需要认证的服务器时，Claude Code 会启动浏览器跳转到授权页面，用户授权后将 token 存储到本地凭据库。后续连接自动使用缓存的 token，过期时自动刷新。

第二种是 XAA（Cross-App Access）模式，这是一种更高级的跨应用访问机制。在企业环境中，MCP 服务器可能需要验证请求者的身份——不仅是用户身份，还包括调用方应用（Claude Code）的身份。XAA 通过 IdP（Identity Provider）登录流程实现这种双重认证。

认证信息按服务器粒度存储，这意味着连接十个 MCP 服务器可能需要十套不同的凭据。这种设计牺牲了便利性，换来了安全性——一个服务器的凭据泄露不会影响其他服务器。

## 18.4 MCPTool：万能适配器

MCPTool 是将 MCP 服务器暴露的工具接入 Claude Code 工具体系的桥梁。它的实现位于 `src/tools/MCPTool/MCPTool.ts`，其设计有一个显著特点——极度灵活的 Schema：

```typescript
// src/tools/MCPTool/MCPTool.ts:14-20
inputSchema = z.object({}).passthrough()  // 接受任意输入
outputSchema = z.string()                  // 输出统一为字符串
```

`z.object({}).passthrough()` 是一个精巧的选择。普通的 `z.object({})` 会拒绝所有未定义的字段，而 `.passthrough()` 让所有字段都能通过验证。这正是 MCP 工具所需要的——因为每个 MCP 服务器提供的工具参数各不相同，MCPTool 无法预先知道具体的 Schema，所以选择了"全部接受，由远端验证"的策略。

工具的注册使用了 `isMcp: true` 标志和命名约定：

```typescript
// src/tools/MCPTool/MCPTool.ts:27-35
export const MCPTool = buildTool({
  isMcp: true,
  isOpenWorld() { return false },
  name: 'mcp',
  maxResultSizeChars: 100_000,
  // ...
})
```

当 MCP 服务器注册工具时，每个工具在 Claude Code 中的名称遵循 `mcp__<服务器名>__<工具名>` 的三段式命名。模型在对话中看到的是一个普通工具，调用时 MCPTool 解析名称中的服务器名，路由到正确的 MCP 客户端连接，再转发调用参数。

`maxResultSizeChars: 100_000` 限制了单次 MCP 工具调用返回的最大字符数。这个阈值比内置工具（通常 30,000-60,000）更宽松，因为 MCP 工具的返回内容不可预测——可能是数据库查询的大结果集、API 返回的完整 JSON 等。

## 18.5 连接生命周期

MCP 连接的全生命周期由 React Hook `useManageMCPConnections`（`src/services/mcp/useManageMCPConnections.tsx`）管理，配合 UI 组件 `MCPConnectionManager`（`src/services/mcp/MCPConnectionManager.tsx`）提供可视化状态反馈。

完整的连接流程如下：

```
启动阶段
  |
  +-- 加载所有作用域的 MCP 配置
  |     +-- enterprise → managed → claudeai → user → project → local
  |     +-- 合并配置，高优先级覆盖低优先级
  |
  +-- 对每个服务器配置：
  |     |
  |     +-- 根据 transport 类型创建传输实例
  |     |     +-- stdio: 启动子进程
  |     |     +-- sse/http/ws: 建立网络连接
  |     |
  |     +-- 认证检查
  |     |     +-- 需要认证？→ OAuth / XAA 流程
  |     |     +-- 有缓存 token？→ 尝试复用
  |     |
  |     +-- 连接 MCP Client
  |     +-- 发现工具列表 (tools/list)
  |     +-- 发现资源列表 (resources/list)
  |
  +-- 注册发现的工具到工具注册表
  +-- 预取资源 (prefetchAllMcpResources)
  |
运行阶段
  |
  +-- 模型输出工具调用: mcp__mydb__query
  +-- MCPTool 解析服务器名: "mydb"
  +-- 找到对应的 MCP Client 连接
  +-- 转发调用: tools/call { name: "query", arguments: {...} }
  +-- 接收结果，截断至 100,000 字符
  +-- 返回给模型
  |
退出阶段
  |
  +-- 关闭所有 MCP Client 连接
  +-- 终止 stdio 子进程
  +-- 清理网络连接
```

`getMcpToolsCommandsAndResources()` 是发现阶段的核心函数，它同时获取工具、命令和资源三类能力。`prefetchAllMcpResources()` 则在连接建立后立即拉取配置为预取的资源内容，避免首次使用时的延迟。

## 18.6 资源发现：ListMcpResourcesTool

除了工具之外，MCP 服务器还可以暴露资源（resources）。资源是只读的数据端点——文档、配置、状态信息等。`ListMcpResourcesTool` 允许模型查询可用的 MCP 资源列表，然后通过资源 URI 读取具体内容。

这种工具+资源的双重机制让 MCP 服务器的设计更加灵活：工具用于执行操作（有副作用），资源用于提供上下文（只读）。模型可以先通过资源了解当前状态，再通过工具执行操作。

## 本章小结

MCP 集成是 Claude Code 扩展性的核心支柱。通过标准化的协议层，五种传输方式覆盖了从本地进程到远程服务的全部场景；七层配置作用域满足了从个人到企业的各级管理需求；OAuth 和 XAA 认证确保了安全的跨边界访问；MCPTool 通过 `passthrough` Schema 和三段式命名实现了对任意外部工具的无缝桥接。整个系统的核心思想是：Claude Code 不需要知道外部工具的细节，只需要知道如何与它们通信。
