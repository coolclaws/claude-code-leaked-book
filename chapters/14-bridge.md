# 第 14 章 Bridge 系统

> "Any two computers can be connected, but making them cooperate is an engineering challenge."
> — 改编自 Andrew S. Tanenbaum

前两章讨论的 AgentTool 和 Team 系统都运行在本地进程内。但 Claude Code 的野心不止于此——通过 Bridge 系统，本地终端可以与云端的远程会话建立持久连接，实现跨机器的代码操作。Bridge 是 Claude Code 实现"远程控制"能力的核心架构，它处理了 WebSocket 通信、JWT 认证、权限委托、断线重连等一系列分布式系统的经典问题。

## 14.1 Bridge 的激活路径

Bridge 模式通过 CLI 命令激活，支持多个别名：

```typescript
// src/entrypoints/cli.tsx:112-162
// 支持的命令别名：'remote-control', 'rc', 'remote', 'sync', 'bridge'
// 激活前置条件：
//   1. 有效的 OAuth 认证令牌
//   2. 策略检查 allow_remote_control == true
//   3. 特性开关 BRIDGE_MODE 已启用
```

三重守门机制确保了 Bridge 不会被意外激活。OAuth 令牌验证用户身份，策略检查确认组织管理员允许远程控制功能，特性开关则让 Anthropic 能够在全局层面控制功能的灰度发布。

## 14.2 核心架构

Bridge 系统的代码分布在 `src/bridge/` 目录下的 31 个文件中，按职责可以划分为四个层次：

```
+-----------------------------------------------------------+
|                    连接管理层                                |
|  bridgeMain.ts      WebSocket 生命周期与断线重连             |
|  replBridge.ts      REPL 与 Bridge 的双向通信               |
+-----------------------------------------------------------+
|                    认证与安全层                              |
|  jwtUtils.ts        JWT 令牌生成与验证                      |
|  trustedDevice.ts   设备信任管理                             |
|  bridgePermissionCallbacks.ts  权限请求处理                  |
+-----------------------------------------------------------+
|                    会话管理层                                |
|  sessionRunner.ts   远程会话执行                             |
|  codeSessionApi.ts  会话 HTTP API                          |
+-----------------------------------------------------------+
|                    消息处理层                                |
|  inboundMessages.ts    入站消息路由                          |
|  inboundAttachments.ts 文件附件处理                          |
|  types.ts              协议类型定义                          |
+-----------------------------------------------------------+
```

Bridge 的整体通信架构可以用如下拓扑表示：

```
本地机器                              云端 (CCR)
+---------------------------+        +---------------------------+
|                           |        |                           |
|  CLI (bridge 模式)         |        |  远程会话                  |
|                           |  WSS   |                           |
|  bridgeMain.ts --------+--+<------>+--+ sessionRunner.ts       |
|                        |  |        |  |                        |
|  replBridge.ts         |  |        |  | codeSessionApi.ts      |
|    |                   |  |        |  |   |                    |
|    v                   |  |        |  |   v                    |
|  权限 UI <---events-----+  |        |  | QueryEngine            |
|                           |        |  |   |                    |
|  文件系统 <--read/write----+  |        |  |   v                    |
|                           |        |  | 工具执行                 |
+---------------------------+        +---------------------------+
```

本地端的 `bridgeMain.ts` 维护与云端的 WebSocket 连接，`replBridge.ts` 处理本地 REPL 和 Bridge 之间的双向通信。云端的 `sessionRunner.ts` 运行实际的 AI 会话，`codeSessionApi.ts` 提供 HTTP API 供外部系统（如 Web 界面）与会话交互。

## 14.3 断线重连与退避策略

分布式系统中，网络中断是常态而非异常。Bridge 采用了精心调校的指数退避策略来处理各类连接问题：

```typescript
// src/bridge/bridgeMain.ts:59-70
export type BackoffConfig = {
  connInitialMs: number      // 2000   初始重连间隔
  connCapMs: number          // 120000 最大重连间隔 (2 分钟)
  connGiveUpMs: number       // 600000 放弃重连时间 (10 分钟)
  generalInitialMs: number   // 500    通用操作初始间隔
  generalCapMs: number       // 30000  通用操作最大间隔
  generalGiveUpMs: number    // 600000 通用操作放弃时间
}
```

配置区分了两个维度："连接级别"（conn）和"通用级别"（general）。连接级别的退避从 2 秒开始，适用于 WebSocket 连接断开后的重连——初始间隔较长是因为网络问题通常不会在毫秒内自行恢复。通用级别从 500 毫秒开始，适用于 API 调用失败等短暂错误。

两个维度共享相同的放弃时间——10 分钟。如果持续 10 分钟无法恢复连接，Bridge 将优雅地终止并通知用户。这个时长平衡了用户体验（不会无限等待）和网络稳定性（给临时性中断足够的恢复窗口）。

退避策略的指数增长遵循经典模式：

```
重试 1:  2000ms
重试 2:  4000ms
重试 3:  8000ms
重试 4:  16000ms
重试 5:  32000ms
重试 6:  64000ms
重试 7:  120000ms (触及上限，后续保持)
...
直到累计等待 > 600000ms，放弃重连
```

## 14.4 会话管理与并发控制

Bridge 模式下，本地机器可以同时服务多个远程会话：

```typescript
// src/bridge/bridgeMain.ts:81-97
const STATUS_UPDATE_INTERVAL_MS = 1000
const SPAWN_SESSIONS_DEFAULT = 32
```

`SPAWN_SESSIONS_DEFAULT = 32` 意味着一个 Bridge 实例默认最多可以同时运行 32 个远程会话。这个数字看似很大，但考虑到每个会话可能只是在等待用户输入或模型响应，实际的 CPU 和内存占用远低于 32 个并发进程。

`STATUS_UPDATE_INTERVAL_MS = 1000` 控制着 Bridge 向云端报告本地状态的频率——每秒一次。状态报告包括当前活跃会话数、系统资源使用情况、各会话的执行进度等。这些信息用于 Web 界面的实时监控和云端的负载均衡决策。

## 14.5 认证与设备信任

Bridge 的安全模型建立在两个层次上：令牌认证和设备信任。

JWT 令牌（`jwtUtils.ts`）用于验证每个 WebSocket 连接和 API 请求的身份。令牌包含用户 ID、组织 ID、权限范围等声明，由 Anthropic 的认证服务签发。Bridge 在每次建立连接时验证令牌的有效性，并在令牌接近过期时自动刷新。

设备信任（`trustedDevice.ts`）是更高层次的安全机制。当用户首次在某台机器上启用 Bridge 时，该设备需要经过一次信任建立流程。一旦设备被标记为受信任，后续的连接可以跳过部分验证步骤，减少连接建立的延迟。设备信任信息存储在本地，与 OAuth 令牌分开管理。

## 14.6 权限委托模型

Bridge 系统面临一个独特的安全挑战：远程会话中的 Agent 需要操作本地文件系统，但它运行在云端，无法直接访问本地资源。解决方案是权限委托——远程 Agent 的每个敏感操作都必须经过本地用户的显式批准。

```
远程 Agent                Bridge                本地用户
    |                       |                      |
    |-- 请求写入文件 -------->|                      |
    |                       |-- 弹出权限对话框 ------>|
    |                       |                      |
    |                       |<-- 批准/拒绝 ---------|
    |<-- 执行结果 ----------|                      |
```

`bridgePermissionCallbacks.ts` 实现了这个委托机制。它注册一组回调函数，当远程会话请求执行需要权限的操作时（文件写入、Shell 命令执行、敏感目录访问），Bridge 将请求转发给本地的权限 UI，等待用户响应后再将决定传回远程会话。

这种设计确保了远程控制不会绕过本地的安全策略。即使远程 Agent 尝试执行危险操作，本地用户始终保有最终决定权。

## 14.7 消息路由与附件处理

入站消息的处理由 `inboundMessages.ts` 统一路由。每条从云端到达的消息都携带类型标识，路由器根据类型将消息分发到对应的处理器：

```
入站消息
  |
  +-- session.create    -> 创建新会话
  +-- session.message   -> 转发用户消息到会话
  +-- session.cancel    -> 取消正在执行的操作
  +-- session.destroy   -> 销毁会话并清理资源
  +-- attachment.upload  -> 处理文件附件
  +-- heartbeat         -> 更新连接存活状态
```

文件附件（`inboundAttachments.ts`）的处理更为复杂。用户可以通过 Web 界面上传文件，这些文件需要被安全地传输到本地机器并放置在正确的位置。附件处理器负责验证文件大小、类型，写入临时目录，然后将文件路径通知给对应的会话。

## 14.8 REPL-Bridge 通信

`replBridge.ts` 是本地 REPL 和 Bridge 之间的桥接层。当用户在终端中直接输入命令时，这些命令也需要被 Bridge 感知到，以便在 Web 界面上同步显示。反过来，从 Web 界面发起的操作也需要在本地终端中有所体现。

这种双向同步确保了无论用户通过哪个界面操作，另一个界面都能实时反映当前状态。实现上，`replBridge.ts` 维护了一个事件总线，本地 REPL 和 Bridge WebSocket 都订阅并发布事件到这个总线上。

## 本章小结

Bridge 系统将 Claude Code 从本地工具扩展为跨机器协作平台。它通过 WebSocket 建立本地与云端的持久连接，通过指数退避策略优雅地处理网络中断，通过 JWT 和设备信任实现双层安全认证，通过权限委托确保远程操作不绕过本地安全策略。31 个文件的代码量反映了分布式通信的固有复杂性——连接管理、消息路由、认证安全、会话并发，每个维度都需要独立但协调的解决方案。Bridge 的存在使得 Claude Code 不再局限于"打开终端、输入命令"的传统模式，而是成为一个可以随时随地通过 Web 界面远程访问的持久化开发助手。
