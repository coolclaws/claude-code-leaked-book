# 第 5 章 认证系统

> "Security is not a product, but a process."
> —— Bruce Schneier

认证是 CLI 工具与云服务之间的信任桥梁。Claude Code 需要在保证安全性的前提下，让认证流程尽可能无感。本章将从 Keychain 预取、OAuth 流程、API Key 管理和 MCP 跨应用认证四个维度，解析 Claude Code 认证系统的完整设计。

## 5.1 Keychain 预取：在用户察觉之前完成

上一章提到，`startKeychainPrefetch()` 在 `main.tsx` 的导入阶段被立即触发。这个设计的动机是：操作系统 Keychain 的访问延迟不可预测。

```typescript
// src/main.tsx:17-20
import {
  ensureKeychainPrefetchCompleted,
  startKeychainPrefetch,
} from "./utils/secureStorage/keychainPrefetch.js";
startKeychainPrefetch();
```

`startKeychainPrefetch()` 向操作系统发起凭证读取请求。在 macOS 上，这意味着通过 Security framework 访问 Keychain；在 Linux 上，可能涉及 libsecret 或 D-Bus 调用。这些操作通常在 50-200 毫秒之间完成，但在某些情况下（如 Keychain 首次解锁、系统负载高）可能需要更长时间。

预取的配合函数是 `ensureKeychainPrefetchCompleted()`。当业务逻辑真正需要凭证时，调用此函数等待预取完成。如果预取已经在后台完成，这个调用几乎是零开销的；如果仍在进行中，则阻塞等待。

```
时间线:

main.tsx 开始
  |
  +-- startKeychainPrefetch() -------> [Keychain I/O 进行中...]
  |                                           |
  +-- 加载 React, Commander...                |
  +-- 加载业务模块...                          |
  +-- init()                                  |
  |     |                                     |
  |     +-- ensureKeychainPrefetchCompleted() -+
  |     |   (如果 Keychain 已就绪则立即返回)
  |     |
  |     +-- 使用凭证继续初始化
```

这种"发射并遗忘，需要时再等待"的模式在整个 Claude Code 中反复出现。它的核心价值是将不可压缩的 I/O 延迟隐藏在 CPU 密集型工作（模块加载）的背后。

## 5.2 OAuth 认证流程

Claude Code 的主要认证方式是 OAuth 2.0。当用户首次使用或 token 过期时，需要通过浏览器完成授权。整个流程涉及多个文件的协作：

```typescript
// src/constants/oauth.ts
// OAuth 配置常量：
// - 授权端点 URL
// - Token 端点 URL
// - Client ID
// - 重定向 URI
// - 授权范围 (scopes)
```

```typescript
// src/services/oauth/
// OAuth 核心服务：
// - 生成授权 URL (含 PKCE challenge)
// - 启动本地 HTTP 服务器接收回调
// - 交换授权码为 access_token
// - 使用 refresh_token 刷新令牌
```

OAuth 流程的完整步骤如下：

```
用户启动 Claude Code
  |
  +-- 检查 Keychain 中是否有有效 token
  |
  [有 token] -----> 验证 token 是否过期
  |                    |
  |              [未过期] -> 直接使用
  |              [已过期] -> 尝试 refresh_token 刷新
  |                            |
  |                      [刷新成功] -> 存储新 token，继续
  |                      [刷新失败] -> 走首次认证流程
  |
  [无 token] -----> 首次认证流程
                      |
                      +-- 生成 PKCE code_verifier + code_challenge
                      +-- 构造授权 URL
                      +-- 启动本地 HTTP 服务器 (监听回调)
                      +-- 渲染 ConsoleOAuthFlow 组件
                      |     |
                      |     +-- 显示 QR 码 (终端内)
                      |     +-- 显示授权 URL
                      |     +-- 尝试自动打开浏览器
                      |
                      +-- 用户在浏览器中授权
                      +-- 浏览器重定向到本地服务器
                      +-- 接收授权码 (authorization_code)
                      +-- 交换为 access_token + refresh_token
                      +-- 存入 Keychain
                      +-- 继续启动
```

`ConsoleOAuthFlow.tsx` 是这个流程中面向用户的部分。作为一个 React 组件（通过 Ink 渲染到终端），它需要在文本终端的限制下提供尽可能好的体验：

```typescript
// src/components/ConsoleOAuthFlow.tsx (~79KB)
// 职责：
// - 在终端中渲染 QR 码（用于移动设备扫码）
// - 显示可点击的授权 URL（用于桌面浏览器）
// - 自动检测浏览器打开是否成功
// - 显示等待状态和错误信息
// - 处理超时和重试逻辑
```

这个组件的体积（约 79KB）反映了终端 OAuth 交互的复杂性。它需要处理各种边界情况：浏览器无法打开、本地端口被占用、网络不可达、用户取消授权等。

## 5.3 Bridge 模式下的认证

当 Claude Code 以 bridge 模式运行时（嵌入到 IDE 插件等宿主环境中），认证流程有所不同：

```typescript
// src/entrypoints/cli.tsx:137-141
const { getClaudeAIOAuthTokens } = await import("../utils/auth.js");
if (!getClaudeAIOAuthTokens()?.accessToken) {
  exitWithError(BRIDGE_LOGIN_ERROR);
}
```

Bridge 模式下，Claude Code 期望宿主环境已经完成了认证，并通过特定机制传递 token。`getClaudeAIOAuthTokens()` 从共享存储中读取这些 token。如果 token 不存在，直接报错退出——bridge 模式不会启动 OAuth 流程，因为终端交互在嵌入式环境中并不可用。

这种"认证前置"的设计简化了 bridge 模式的逻辑：要么宿主已经提供了有效凭证，要么直接失败。不存在中间状态。

## 5.4 JWT 令牌处理

OAuth 流程获取到的 token 通常是 JWT（JSON Web Token）格式。`jwtUtils.ts` 提供了 JWT 的解析和验证功能：

```typescript
// src/bridge/jwtUtils.ts
// JWT 工具函数：
// - 解码 JWT payload（无需验证签名，用于读取过期时间等元数据）
// - 检查 token 是否过期
// - 提取用户标识信息
```

JWT 的客户端解码用于两个关键判断：token 是否即将过期（需要提前刷新），以及当前登录的是哪个账户（多账户支持）。注意，Claude Code 不在客户端验证 JWT 签名——签名验证是服务端的职责，客户端只需提取元数据即可。

## 5.5 API Key 认证

除了 OAuth，Claude Code 还支持直接使用 API Key 认证。这是为开发者和自动化场景提供的简化路径：

```
API Key 认证流程:

环境变量 ANTHROPIC_API_KEY
  |
  +-- [已设置] -> 直接使用，跳过 OAuth
  |
  +-- [未设置] -> 检查 Keychain 中是否存储了 API Key
                    |
                    +-- [有] -> 使用存储的 Key
                    +-- [无] -> 走 OAuth 流程
```

API Key 认证的优先级高于 OAuth token。这意味着，如果用户同时配置了 API Key 和 OAuth，API Key 会被优先使用。这种设计让 CI/CD 环境可以通过环境变量注入 API Key，完全绕过交互式的 OAuth 流程。

## 5.6 MCP 认证与跨应用访问

MCP（Model Context Protocol）服务器的认证是独立于主认证流程的子系统。每个 MCP 服务器可以有自己的认证要求，`mcp/auth.ts` 处理这些多样的认证场景：

```typescript
// src/services/mcp/auth.ts (~88KB)
// MCP 认证核心：
// - 为每个 MCP 服务器维护独立的 OAuth 会话
// - 支持 XAA（Cross-App Access）跨应用令牌交换
// - 管理 MCP 服务器的 token 生命周期
// - 处理认证失败时的降级和重试
```

XAA（Cross-App Access）是一个值得深入理解的机制。当一个 MCP 服务器需要以用户身份访问另一个服务时，直接共享用户的主 token 是不安全的（违反最小权限原则）。XAA 通过令牌交换（token exchange）生成一个范围受限的派生 token，只授予 MCP 服务器所需的最小权限。

```
XAA 令牌交换流程:

用户的主 OAuth token (完整权限)
  |
  +-- MCP 服务器请求特定资源的访问权限
  |
  +-- Claude Code 向认证服务器发起令牌交换
  |   (携带主 token + 请求的范围限制)
  |
  +-- 认证服务器返回派生 token (受限权限)
  |
  +-- 派生 token 传递给 MCP 服务器
  |
  +-- MCP 服务器使用派生 token 访问资源
      (只能访问授权范围内的资源)
```

这种设计确保了即使某个 MCP 服务器被恶意利用，泄露的 token 也只能访问有限的资源，不会危及用户的完整账户权限。

`mcp/auth.ts` 文件的体积（约 88KB）在整个代码库中属于较大的单文件之一。这反映了 MCP 认证场景的复杂性：需要处理多种 OAuth 提供商、各种 token 格式、网络错误重试、并发请求的锁管理等。

## 5.7 认证架构总览

将以上各部分汇总，Claude Code 的认证架构可以描绘为一个分层体系：

```
+--------------------------------------------------+
|                   CLI 入口层                      |
|  cli.tsx: bridge 模式 token 检查                  |
+--------------------------------------------------+
          |                          |
+---------+----------+    +----------+---------+
|    主认证流程       |    |   MCP 认证子系统    |
| OAuth + API Key    |    |  per-server OAuth  |
| Keychain 存储      |    |  XAA 令牌交换       |
+--------------------+    +--------------------+
          |                          |
+--------------------------------------------------+
|              安全存储层                            |
|  keychainPrefetch.ts: 预取优化                    |
|  Keychain/libsecret: 加密存储                     |
+--------------------------------------------------+
          |
+--------------------------------------------------+
|              令牌管理层                            |
|  jwtUtils.ts: 解码与过期检查                      |
|  refresh_token: 自动续期                          |
+--------------------------------------------------+
```

主认证流程和 MCP 认证子系统是两条独立的认证路径，共享底层的安全存储和令牌管理能力。这种分离确保了 MCP 服务器的认证故障不会影响主流程，反之亦然。

## 本章小结

Claude Code 的认证系统在安全性和便捷性之间取得了平衡。Keychain 预取将凭证读取的延迟隐藏在启动过程中，OAuth 流程通过 QR 码和浏览器自动打开降低了交互摩擦，API Key 为自动化场景提供了零交互的认证路径。MCP 子系统的独立认证和 XAA 令牌交换机制则体现了最小权限原则的工程实践。整个认证架构的分层设计——入口检查、主流程与 MCP 子系统分离、共享安全存储——让系统在面对多样的认证场景时保持了清晰的边界和可控的复杂度。
