# 第 21 章 性能与启动优化

> "Premature optimization is the root of all evil, but late optimization is the root of all failure."
> —— 改编自 Donald Knuth

CLI 工具的响应速度是用户体验的生命线。当用户在终端敲下 `claude` 并按下回车，他的耐心窗口只有几百毫秒——超过这个阈值，工具就会从"即时助手"降级为"需要等待的程序"。Claude Code 在性能优化上投入了大量工程精力，从编译时的死代码消除到运行时的模块懒加载，从纳秒级的启动探针到采样式的生产监控，形成了一套多层次的性能工程体系。本章将深入这些优化手段的实现细节。

## 21.1 启动性能探针：startupProfiler

要优化性能，首先要能度量性能。`startupProfiler.ts` 是 Claude Code 的启动性能度量核心，它在启动流程的关键节点插入探针，收集高精度时间数据。

```typescript
// src/utils/startupProfiler.ts:26
const DETAILED_PROFILING = isEnvTruthy(process.env.CLAUDE_CODE_PROFILE_STARTUP);
```

这行代码定义了两种运行模式。当环境变量 `CLAUDE_CODE_PROFILE_STARTUP` 被设为真值时，profiler 进入详细模式，每个检查点的耗时都会打印到控制台，供开发者实时观察。在生产环境中，profiler 默认以静默模式运行，仅在需要时上报数据。

上报的采样策略经过精心设计：

```typescript
// src/utils/startupProfiler.ts:30
const STATSIG_SAMPLE_RATE = 0.005; // 外部用户 0.5%，内部用户 100%
```

千分之五的外部采样率是一个平衡点——每 200 次启动采集一次，既能获得统计意义上的性能趋势，又不会让数据上报本身成为性能负担。内部用户（Anthropic 员工）则采集全量数据，便于在开发阶段捕获性能回退。

探针的核心是 `profileCheckpoint` 函数：

```typescript
// src/utils/startupProfiler.ts:65
// profileCheckpoint(name) 使用 perf.mark() 记录高精度时间戳
// 每次调用都在 Performance Timeline 上打下一个命名标记
```

这些检查点被组织成若干阶段（phase），每个阶段由一对检查点的时间差定义：

```typescript
// src/utils/startupProfiler.ts:49-54
// import_time:   ['cli_entry', 'main_tsx_imports_loaded']    模块加载耗时
// init_time:     ['init_function_start', 'init_function_end'] 初始化逻辑耗时
// settings_time: ['eagerLoadSettings_start', 'eagerLoadSettings_end'] 配置加载耗时
// total_time:    ['cli_entry', 'main_after_run']              端到端总耗时
```

`getReport()` 函数（第 81 行）将所有检查点格式化为可读的文本报告，在详细模式下输出到控制台。`profileReport()` 函数（第 123 行）则将阶段耗时上报至 Statsig 分析平台，`logStartupPerf()`（第 159 行）负责将各阶段的持续时间记录到日志系统。`isDetailedProfilingEnabled()`（第 147 行）供其他模块查询当前是否处于详细分析模式，据此决定是否执行额外的性能追踪逻辑。

对于非交互式场景，`headlessProfiler.ts` 提供了一套对等的度量能力。Headless 模式下没有终端 UI 的渲染开销，但 API 调用和工具执行的耗时仍然需要监控，该 profiler 专门采集这些指标。

## 21.2 快速路径与分层过滤

启动优化的第一原则是"不做不必要的工作"。`cli.tsx` 通过一系列快速路径实现了分层过滤：

```typescript
// src/entrypoints/cli.tsx:37-42
if (process.argv.includes("--version")) {
  console.log(version);
  process.exit(0);
}
```

这是最极端的优化——零导入快速路径。`--version` 不加载 React，不加载 Commander，不初始化任何服务，直接打印版本号退出。整个过程的模块加载量为零，耗时控制在几十毫秒以内。

快速路径的设计遵循"从简到繁"的过滤顺序：

```
cli.tsx 入口
  |
  +-- --version: 0 次导入，瞬时退出
  |
  +-- --dump-system-prompt: 最小导入，打印后退出
  |
  +-- --daemon-worker: 进入守护进程循环，跳过 UI 初始化
  |
  +-- 常规启动: 动态导入 main.tsx，进入完整流程
```

每一层过滤都减少了后续代码路径需要承担的启动成本。只有当所有快速路径都未命中时，程序才会付出完整启动的代价。

## 21.3 副作用导入与并行预取

`main.tsx` 的文件头部是整个启动序列中最精妙的设计。它利用 JavaScript 模块加载的同步特性，在重量级模块解析之前发射异步 I/O 操作：

```typescript
// src/main.tsx:1-20 (导入顺序)
// 1. profileCheckpoint('main_tsx_entry')    <-- 打下时间戳
// 2. startMdmRawRead()                     <-- 启动 MDM 子进程
// 3. startKeychainPrefetch()               <-- 启动 Keychain 子进程
// 4. import React, Commander, chalk...     <-- 重量级模块解析（约 135ms）
```

这段代码的关键在于时序重叠。`startMdmRawRead()` 和 `startKeychainPrefetch()` 各自启动一个子进程执行系统调用——前者读取 MDM（移动设备管理）配置，后者从系统密钥链预取凭证。这两个操作都是 I/O 密集型的，需要等待操作系统响应。通过在模块解析之前发射它们，子进程的 I/O 等待与 JavaScript 引擎的模块解析同时进行，当重量级导入完成时，预取的数据往往已经就绪：

```
时间线 -->
[startMdmRawRead]----[子进程执行]----[数据就绪]
[startKeychainPrefetch]--[子进程执行]------[数据就绪]
[重量级模块导入]---------------------------[解析完成]
                                           |
                                       init() 使用预取结果
```

这种设计的代价是代码可读性的降低——导入顺序承载了隐式的执行语义，任何重排都可能破坏并行策略。但对于一个日均调用量极大的 CLI 工具，这种取舍是值得的。

## 21.4 Bun 构建时优化

Claude Code 使用 Bun 作为运行时和构建工具，充分利用了 Bun 提供的编译时优化能力。

`feature()` 函数来自 `bun:bundle` 模块，它实现了构建时的特性开关。与运行时的 `if` 判断不同，`feature()` 在构建阶段就决定了代码路径——未启用的特性对应的代码在打包时被直接删除，这就是死代码消除（Dead Code Elimination, DCE）：

```typescript
// 构建时特性开关（概念示意）
// 如果 feature("internal_tools") 在构建配置中为 false，
// 则整个 if 分支及其引用的模块都不会进入最终产物
if (feature("internal_tools")) {
  // 这段代码在外部构建中被完全消除
  const { InternalDebugTool } = await import("./internal-debug.js");
}
```

`tools.ts` 和 `commands.ts` 大量使用了 `feature()` 门控。不同的构建目标（内部版、外部版）会产出不同的工具集和命令集，确保外部用户不会加载内部专用模块，也不必为这些模块支付启动成本。

`MACRO.VERSION` 是另一个构建时优化——版本号在编译阶段被内联为字符串常量，运行时无需读取 `package.json` 或执行文件系统操作。

Bun 的原生 ES Module 支持也带来了显著的启动加速。与 Node.js 需要在 CommonJS 和 ESM 之间进行互操作不同，Bun 直接执行 ESM 模块，省去了模块格式转换的开销。

## 21.5 懒加载模式

除了构建时优化，Claude Code 还广泛使用运行时懒加载来推迟非关键模块的初始化。

`lazySchema()` 模式是一个典型案例。Zod schema 的构造涉及大量对象创建和类型推导，如果在模块加载时就构造所有 schema，会增加不必要的启动开销。`lazySchema()` 将 schema 的构造推迟到首次访问时：

```typescript
// lazySchema 模式（概念示意）
// schema 定义在闭包中，仅在第一次调用 .parse() 时才真正构造
// 后续调用直接使用缓存的实例
const mySchema = lazySchema(() => z.object({
  name: z.string(),
  config: z.record(z.unknown()),
}));
```

动态 `import()` 在整个代码库中被广泛使用，用于按需加载特性门控的功能模块。只有当用户实际触发某个功能时，相关模块才会被加载和初始化。这种策略将启动时的模块加载量控制在最小必要集合内。

## 21.6 成本追踪

`cost-tracker.ts` 实现了 API 使用的成本监控。它追踪每次 API 调用的 token 消耗量，按模型和调用类型分类汇总，为用户提供实时的费用感知。成本追踪器本身的实现也遵循轻量原则——它只在 API 响应中提取 usage 字段并累加，不引入额外的网络请求或复杂计算，确保追踪行为不会成为性能瓶颈。

## 本章小结

Claude Code 的性能优化是一套完整的工程体系，贯穿编译时、加载时和运行时三个阶段。编译时，`bun:bundle` 的 `feature()` 函数实现死代码消除，`MACRO.VERSION` 内联常量值，不同构建目标产出不同的代码体积。加载时，`cli.tsx` 的快速路径分层过滤掉简单操作，`main.tsx` 的副作用导入将 I/O 预取与模块解析并行化，`lazySchema()` 推迟非关键 schema 的构造。运行时，动态 `import()` 按需加载功能模块，成本追踪器以最小开销监控 API 用量。`startupProfiler` 和 `headlessProfiler` 为整个体系提供了可度量的基础——没有度量就没有优化，没有持续监控就无法阻止性能退化。这套多层次的优化策略，让 Claude Code 在功能日益丰富的同时，始终保持着令人满意的响应速度。
