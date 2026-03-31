# 第 3 章 启动序列

> "The fastest code is the code that never runs."
> —— Robert Galanakis

CLI 工具的启动速度直接影响用户体验。每多一毫秒的延迟，都会在用户的潜意识中积累不满。Claude Code 的启动序列设计体现了一个核心原则：**能不加载的就不加载，能并行的就并行**。本章将沿着从 `cli.tsx` 到 `main.tsx` 的调用链，逐行拆解这套精心编排的启动流程。

## 3.1 入口：cli.tsx 的快速路径

一切从 `cli.tsx` 的 `main()` 函数开始。打开这个文件，最先映入眼帘的是两行看似不起眼的代码：

```typescript
// src/entrypoints/cli.tsx:1-6
import { feature } from "../utils/feature.js";
process.env.COREPACK_ENABLE_AUTO_PIN = "0";
```

`feature()` 是特性开关系统的入口，必须在所有业务逻辑之前加载。而 `COREPACK_ENABLE_AUTO_PIN` 的赋值则是一个防御性修复——Node.js 的 corepack 工具在某些环境下会自动修改 `package.json`，这行代码将其关闭，避免在用户项目中产生意外的副作用。

紧接着是第一个快速路径：

```typescript
// src/entrypoints/cli.tsx:33-42
if (process.argv.includes("--version")) {
  // 直接打印版本号并退出，不加载任何其他模块
  console.log(version);
  process.exit(0);
}
```

这是启动优化中最经典的技巧——**零导入快速路径**（zero-import fast path）。当用户只是想看一下版本号时，程序不会加载 React、Commander、chalk 或任何其他依赖，直接打印并退出。这使得 `claude --version` 可以在几十毫秒内完成，而非等待数百毫秒的模块加载。

通过版本检查之后，启动性能追踪正式开始：

```typescript
// src/entrypoints/cli.tsx:44-48
import { profileCheckpoint } from "../utils/startupProfiler.js";
profileCheckpoint("cli_entry");
```

`profileCheckpoint` 是整个启动序列的"秒表"，它在关键节点打下时间戳，供后续分析使用。`cli_entry` 是第一个被记录的检查点。

之后是另外几条快速路径：

```typescript
// src/entrypoints/cli.tsx:50-71
// --dump-system-prompt：仅限内部使用，打印系统提示词并退出
// --daemon-worker：守护进程工作线程，直接进入工作循环
// bridge/remote 模式：桥接主流程，不进入常规启动
```

每一条快速路径都是一次"剪枝"——越早退出，就有越多的模块不需要加载。这种分层过滤的设计，确保了每种使用场景只承担自己真正需要的启动成本。

## 3.2 主模块：main.tsx 的并行预取

当所有快速路径都未命中时，`cli.tsx` 通过动态 `import('../main.js')` 进入主模块。`main.tsx` 的文件头部有一段注释，解释了其导入顺序的深意：

```typescript
// src/main.tsx:1-8
// IMPORTANT: The ordering of side-effect imports below matters.
// profileCheckpoint must come before other imports to accurately
// measure import time. MDM and keychain reads must start before
// heavy imports to maximize parallelism.
```

这段注释揭示了 `main.tsx` 的核心设计意图：**利用 JavaScript 的同步模块加载特性，在模块解析的间隙发起异步操作**。具体来说：

```typescript
// src/main.tsx:9-12
import { profileCheckpoint } from "./utils/startupProfiler.js";
profileCheckpoint("main_tsx_entry");
```

首先打下第二个时间戳 `main_tsx_entry`，标记进入主模块的时刻。

```typescript
// src/main.tsx:13-16
import { startMdmRawRead } from "./utils/settings/mdm/rawRead.js";
startMdmRawRead();
```

`startMdmRawRead()` 立即启动 MDM（Mobile Device Management）配置读取。在企业环境中，这意味着通过 `plutil`（macOS）或 `reg query`（Windows）子进程读取系统级管理策略。关键在于，这个子进程是非阻塞的——它被发射出去后就不管了，后续代码继续执行。

```typescript
// src/main.tsx:17-20
import { startKeychainPrefetch } from "./utils/secureStorage/keychainPrefetch.js";
startKeychainPrefetch();
```

同样的策略用于 Keychain 预取。操作系统的密钥链访问通常需要几十到几百毫秒（尤其当系统弹出授权对话框时），提前发起请求可以让这段等待与后续的模块加载重叠。

```typescript
// src/main.tsx:21-50
// 常规导入：React, Commander, chalk, Ink, 各种服务模块...
import React from "react";
import { Command } from "commander";
// ... 大量业务模块
```

这些"重量级"导入可能花费数百毫秒。但此时 MDM 子进程和 Keychain 读取已经在后台运行，等到业务代码真正需要这些数据时，它们很可能已经就绪。

## 3.3 完整启动流程

将以上分析汇总，Claude Code 的完整启动序列如下：

```
cli.tsx main()
  |
  +-- Fast path: --version? -----> print & exit (零导入)
  |
  +-- import startupProfiler
  |   profileCheckpoint('cli_entry')
  |
  +-- Fast path: --dump-system-prompt? -> print & exit
  +-- Fast path: --daemon-worker? -----> run & exit
  +-- Fast path: bridge/remote? -------> bridgeMain & exit
  |
  +-- import('../main.js') ---------> main.tsx
      |
      +-- profileCheckpoint('main_tsx_entry')
      |
      +-- startMdmRawRead()          [后台子进程启动]
      +-- startKeychainPrefetch()     [后台子进程启动]
      |         |                          |
      |    [并行执行: plutil/reg]    [并行执行: keychain]
      |         |                          |
      +-- [重量级导入: React, Commander, services...]
      |         |                          |
      |    [MDM 数据就绪]           [Keychain 数据就绪]
      |
      +-- init() -> setup() -> launchRepl()
```

这幅图清晰地展示了并行策略：MDM 读取、Keychain 预取和模块加载三条线同时推进，最大化利用了启动阶段的等待时间。

## 3.4 性能追踪：startupProfiler

启动性能追踪由 `startupProfiler.ts` 实现。它的设计兼顾了开发调试和生产监控两个场景：

```typescript
// src/utils/startupProfiler.ts:26
const DETAILED_PROFILING = isEnvTruthy(process.env.CLAUDE_CODE_PROFILE_STARTUP);
```

设置环境变量 `CLAUDE_CODE_PROFILE_STARTUP=1` 即可开启详细分析模式，此时每个 checkpoint 的耗时都会打印到控制台。这对于开发者排查启动性能回退非常有用。

在生产环境中，profiler 以极低的采样率上报数据：

```typescript
// src/utils/startupProfiler.ts:30
const STATSIG_SAMPLE_RATE = 0.005;
```

千分之五的采样率意味着每 200 次启动只上报一次，既能收集到统计意义上的性能数据，又不会对正常使用产生可感知的影响。

Profiler 将启动过程划分为几个阶段：

```typescript
// src/utils/startupProfiler.ts:49-54
// import_time:   模块加载耗时
// init_time:     初始化逻辑耗时
// settings_time: 配置加载耗时
// total_time:    端到端总耗时
```

每个阶段由 `profileCheckpoint` 函数通过 `perf.mark()` 打下标记：

```typescript
// src/utils/startupProfiler.ts:65
// profileCheckpoint 使用 Node.js 的 Performance API
// 在关键节点调用 perf.mark(name)，记录高精度时间戳
```

最终由 `profileReport()` 函数计算各阶段的耗时差值，并将结果上报至 Statsig 分析平台。这套机制让团队能够持续监控启动性能，在回退发生时迅速定位到具体阶段。

## 3.5 设计取舍

Claude Code 的启动优化并非没有代价。将副作用代码（`startMdmRawRead`、`startKeychainPrefetch`）穿插在模块顶层导入之间，牺牲了代码的可读性和可测试性。模块的导入顺序变成了一个隐式的执行契约，任何重排都可能破坏并行策略。文件头部的注释正是对这一脆弱性的坦诚承认。

但这种取舍是值得的。对于一个日均被调用数百万次的 CLI 工具，每次启动节省 100 毫秒，累计就是巨大的用户时间。快速路径的分层设计更是将"最常见的简单操作"和"完整功能启动"的成本彻底隔离，让轻量使用场景不必为重量级功能买单。

## 本章小结

Claude Code 的启动序列是一堂关于"时间预算"的课。`cli.tsx` 通过快速路径逐层过滤，将 `--version` 等简单操作的响应时间压到极致。`main.tsx` 通过在模块加载前发射 MDM 和 Keychain 的异步读取，将 I/O 等待与 CPU 密集的模块解析重叠执行。`startupProfiler` 则为整个过程提供了可观测性，确保性能优化不会随着代码演进而悄然退化。这三层设计——快速退出、并行预取、持续度量——构成了一套完整的启动性能工程体系。
