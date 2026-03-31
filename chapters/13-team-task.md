# 第 13 章 Team 与 Task 系统

> "No individual can win a game by himself; it takes the whole team."
> — 改编自 Phil Jackson

上一章我们分析了 AgentTool 如何创建和管理单个子 Agent。但在更复杂的场景中，多个 Agent 需要组成团队、彼此通信、协调分工。Claude Code 的 Team 与 Task 系统正是为此而设计——Task 提供了统一的后台任务抽象，Team 在此之上构建了多 Agent 协作框架，Coordinator 模式则定义了团队的组织和通信规则。

## 13.1 Task 类型系统

`src/Task.ts` 定义了 Claude Code 中所有后台任务的类型基础。首先是任务类型的联合定义：

```typescript
// src/Task.ts:6-13
type TaskType =
  | 'local_bash'
  | 'local_agent'
  | 'remote_agent'
  | 'in_process_teammate'
  | 'local_workflow'
  | 'monitor_mcp'
  | 'dream'
```

七种任务类型覆盖了 Claude Code 中所有需要后台执行的场景。`local_bash` 对应 Shell 命令的后台执行，`local_agent` 是上一章介绍的后台子 Agent，`remote_agent` 通过 CCR（Claude Code Remote）在远程环境执行，`in_process_teammate` 是团队内的协作 Agent，`local_workflow` 运行用户定义的工作流脚本，`monitor_mcp` 监控 MCP 服务器状态，而 `dream` 则是一种特殊的后台推理任务。

每种任务类型都有一个对应的单字母前缀，用于生成全局唯一的任务 ID：

```typescript
// src/Task.ts:79-87
const TASK_ID_PREFIXES = {
  local_bash:          'b',
  local_agent:         'a',
  remote_agent:        'r',
  in_process_teammate: 't',
  local_workflow:      'w',
  monitor_mcp:        'm',
  dream:              'd',
}
```

任务 ID 的生成算法简洁而实用：

```typescript
// src/Task.ts:96-98
const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
// generateTaskId() = 前缀 + 8 位随机字符
// 示例：a7k2xm9p（一个 local_agent 任务）
```

36 个字符的字母表产生 36^8 约 2.8 万亿种组合，在单次会话的生命周期内碰撞概率几乎为零。单字母前缀的设计使得从任务 ID 就能立即识别任务类型，无需查询额外的元数据。

## 13.2 Task 状态机

每个任务都遵循一个简单但完备的状态机：

```typescript
// src/Task.ts:15-20
type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed'
```

状态流转规则如下：

```
                 +----------- killed <-----------+
                 |                                |
                 |                                |
  pending ------+------> running -------> completed
                            |
                            +-----------> failed
                            |
                            +-----------> killed
```

`pending` 是任务刚被创建但尚未开始执行的状态。一旦执行器获取到资源，任务进入 `running`。从 `running` 出发，任务可以自然完成（`completed`）、因错误失败（`failed`）、或被外部取消（`killed`）。值得注意的是，`pending` 状态的任务也可以直接被 `killed`——这发生在任务还在排队等待时用户就取消了整个操作。

判断任务是否已终结的辅助函数直观地检查三个终态：

```typescript
// src/Task.ts:27
function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}
```

## 13.3 TaskStateBase 与 TaskContext

每个任务实例都包含一组基础状态字段：

```typescript
// src/Task.ts:45-57
interface TaskStateBase {
  id: string           // 任务唯一 ID
  type: TaskType       // 任务类型
  status: TaskStatus   // 当前状态
  description: string  // 人类可读的描述
  startTime: number    // 开始时间戳
  endTime?: number     // 结束时间戳（终态时设置）
  outputFile?: string  // 输出文件路径
  notified: boolean    // 是否已通知用户完成
}
```

`outputFile` 字段揭示了一个重要的设计决策：后台任务的输出不是保存在内存中，而是写入文件系统。这确保了即使主进程重启或内存压力过大，任务的输出仍然可以被回溯查看。`notified` 字段防止同一个任务完成通知被重复发送给用户。

任务执行器通过 `TaskContext` 获取运行时环境：

```typescript
// src/Task.ts:36-42
interface TaskContext {
  abortController: AbortController  // 取消控制器
  getAppState: () => AppState       // 读取应用状态
  setAppState: (updater) => void    // 更新应用状态
}
```

`AbortController` 是 Web 标准的取消原语，它通过信号传播机制实现层级取消——当父级任务被取消时，其 `AbortController` 发出信号，所有监听该信号的子操作（网络请求、文件 I/O、子 Agent 循环）都会收到取消通知并清理资源。

## 13.4 Task 执行器架构

`src/tasks/` 目录下的每种任务类型都有一个独立的执行器模块：

```
src/tasks/
  |
  +-- LocalShellTask/       Shell 命令后台执行
  |     +-- 管理子进程生命周期
  |     +-- 捕获 stdout/stderr
  |     +-- 支持超时和信号转发
  |
  +-- LocalAgentTask/       子 Agent 后台执行
  |     +-- 创建独立 QueryEngine
  |     +-- 维护 ProgressTracker
  |     +-- 输出写入 outputFile
  |
  +-- RemoteAgentTask/      CCR 远程 Agent
  |     +-- 通过 Bridge 连接远程环境
  |     +-- 转发工具调用和权限请求
  |
  +-- InProcessTeammateTask/  团队内协作 Agent
  |     +-- 共享进程内存空间
  |     +-- 通过消息队列通信
  |
  +-- LocalWorkflowTask/    工作流脚本
  |     +-- 执行用户定义的流程
  |     +-- 支持步骤编排
  |
  +-- DreamTask/            后台推理任务
        +-- 低优先级后台推理
        +-- 预热缓存和上下文
```

每个执行器都实现了 `TaskHandle` 接口：

```typescript
// src/Task.ts:31-34
interface TaskHandle {
  taskId: string
  cleanup?: () => Promise<void>
}
```

`cleanup` 函数确保任务在终结时能够释放资源——关闭文件句柄、终止子进程、移除 Git 工作树等。

## 13.5 Team 工具集

Team 系统构建在 Task 之上，通过三个专用工具实现多 Agent 团队的创建和通信：

```
+-------------------+    创建     +------------------+
| TeamCreateTool    |----------->| Agent 团队        |
| (TEAM_CREATE)     |            | 包含 N 个成员     |
+-------------------+            +------------------+
                                   |      ^
+-------------------+    消息     |      |
| SendMessageTool   |----------->|      |
| (SEND_MESSAGE)    |<-----------+      |
+-------------------+                   |
                                        |
+-------------------+    删除           |
| TeamDeleteTool    |-------------------+
| (TEAM_DELETE)     |
+-------------------+
```

`TeamCreateTool` 负责定义团队结构——指定成员数量、每个成员的角色描述和工具权限。`SendMessageTool` 实现成员间的消息传递，它是团队协作的核心通道。`TeamDeleteTool` 在任务完成后清理团队资源。

这三个工具都是内部工具（Internal Tools），它们不会出现在普通用户的工具列表中，只在 Coordinator 模式下可用。

## 13.6 Coordinator 模式

Coordinator 模式是 Team 系统的运行时框架，定义在 `src/coordinator/coordinatorMode.ts` 中。在此模式下，主 Agent 扮演协调者角色，它不直接执行具体任务，而是将工作分配给团队成员：

```
                    +------------------+
                    |   Coordinator    |
                    |   (主 Agent)      |
                    +--------+---------+
                             |
              +--------------+--------------+
              |              |              |
              v              v              v
        +-----------+  +-----------+  +-----------+
        | Worker A  |  | Worker B  |  | Worker C  |
        | (前端)     |  | (后端)     |  | (测试)     |
        +-----------+  +-----------+  +-----------+
              |              |              |
              v              v              v
        受限工具集       受限工具集       受限工具集
```

`isCoordinatorMode()` 和 `matchSessionMode()` 两个函数控制着模式的激活和匹配。当 Coordinator 模式激活时，主 Agent 的工具集被替换为四个内部工具：`TEAM_CREATE`、`TEAM_DELETE`、`SEND_MESSAGE` 和 `SYNTHETIC_OUTPUT`。

Worker Agent 通过 `AgentTool` 产生，但它们的工具集被严格限制。每个 Worker 只能使用与其角色相关的工具——一个负责前端的 Worker 可能只能访问 `src/components/` 目录下的文件，而一个负责测试的 Worker 只能运行测试命令。

`SYNTHETIC_OUTPUT` 工具允许 Coordinator 直接向用户输出信息，而不需要等待所有 Worker 完成。这在长时间运行的团队任务中很有用——Coordinator 可以在 Worker 执行过程中报告阶段性进展。

## 13.7 多 Agent 通信模型

团队内的 Agent 通信遵循"Coordinator 中转"模型。Worker 之间不直接通信，所有消息都通过 Coordinator 转发。这种星形拓扑虽然增加了通信延迟，但大大简化了协调逻辑——Coordinator 可以在转发消息时进行过滤、聚合、甚至翻译（将一个 Worker 的技术细节转化为另一个 Worker 能理解的上下文）。

每个 `InProcessTeammateTask` 运行在同一个进程中，共享内存空间但拥有独立的 QueryEngine 实例和消息队列。这意味着团队成员之间的"消息传递"实际上是内存中的对象引用传递，没有序列化和网络开销。

## 本章小结

Team 与 Task 系统为 Claude Code 提供了完整的多 Agent 协作基础设施。Task 层定义了统一的任务抽象——七种类型、五种状态、文件化输出、层级取消。Team 层在此之上构建了团队创建、消息通信和资源清理的工具集。Coordinator 模式将主 Agent 从执行者提升为协调者，通过星形通信拓扑管理多个受限 Worker 的协同工作。这套设计的精妙之处在于它的层次分明：单个子 Agent 由 AgentTool 管理，后台执行由 Task 框架承载，多 Agent 协作由 Team 工具编排，各层职责清晰、互不越界。
