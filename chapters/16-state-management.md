# 第 16 章 状态管理

> "State is the root of all evil in programming. But you can't escape it — you can only contain it."
> —— Pete Hunt

每一个交互式应用的核心挑战都是状态管理。Claude Code 作为一个有状态的 REPL 工具，需要同时追踪用户设置、对话历史、工具权限、Agent 任务、MCP 连接等多种状态。引入 Redux 这样的重型方案会带来不必要的复杂性，而完全不加管理又会让状态散落各处、难以维护。Claude Code 选择了一条中间路线：一个极简的自研 Store，配合 React Context 分发，用最少的抽象覆盖所有需求。

## 16.1 Store：40 行代码的状态容器

整个状态管理系统的基座是 `src/state/store.ts` 中的 `createStore` 函数。它的完整实现不到 40 行：

```typescript
// src/state/store.ts（完整文件）
type Listener = () => void
type OnChange<T> = (args: { newState: T; oldState: T }) => void

export type Store<T> = {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: Listener) => () => void
}

export function createStore<T>(initialState: T, onChange?: OnChange<T>): Store<T> {
  let state = initialState
  const listeners = new Set<Listener>()
  return {
    getState: () => state,
    setState: (updater) => {
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) return
      state = next
      onChange?.({ newState: next, oldState: prev })
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
```

这段代码虽短，但包含了状态管理的全部核心要素。

**不可变更新**。`setState` 接收一个 updater 函数而非新状态值，强制调用者基于旧状态计算新状态。这避免了"读取过期状态再覆盖"的竞态问题——当多个异步操作同时修改状态时，每个 updater 都能拿到最新的 `prev`。

**引用相等性跳过**。`Object.is(next, prev)` 检查确保了如果 updater 返回的对象与旧状态引用相同，则跳过所有后续操作。这个优化在实践中非常重要——许多条件性更新（"如果已经是这个值就不改"）不需要在每个调用处手动判断，Store 会自动处理。

**onChange 回调**。除了通知 UI 订阅者之外，`onChange` 回调提供了一个处理副作用的入口。在 `AppStateStore` 中，这个回调被用来执行状态变更后的级联操作，例如当权限模式改变时更新工具可用性。

**订阅与取消**。`subscribe` 返回一个取消订阅的函数，这个模式与 React 18+ 的 `useSyncExternalStore` API 完美契合，使得 Store 可以直接作为 React 外部状态源。

## 16.2 AppState：应用的全局状态

`src/state/AppStateStore.ts` 定义了应用的核心状态类型。这个类型使用了 `DeepImmutable` 包装，在编译期禁止对状态对象的直接修改：

```typescript
// src/state/AppStateStore.ts:89-158（AppState 类型关键字段）
// AppState = DeepImmutable<{
//   settings: SettingsJson          // 用户设置
//   verbose: boolean                // 详细输出模式
//   mainLoopModel: ModelSetting     // 主循环使用的模型
//   expandedView: 'none' | 'tasks' | 'teammates'  // 展开视图
//   toolPermissionContext: ToolPermissionContext    // 工具权限上下文
//   kairosEnabled: boolean          // Kairos 功能开关
//   tasks: ...                      // 任务列表（可变部分）
//   agentNameRegistry: ...          // Agent 名称注册表
//   mcp: ...                        // MCP 连接状态
//   plugins: ...                    // 插件状态
// }>
```

`DeepImmutable` 是一个递归的 TypeScript 工具类型，将对象的所有属性标记为 `readonly`。这意味着任何试图直接赋值 `state.verbose = true` 的代码都会在编译时报错——必须通过 `setState` 的 updater 函数创建新对象。

状态中有一个值得注意的设计决策：`tasks`、`agentNameRegistry`、`mcp` 和 `plugins` 被标注为"可变部分"。这些字段内部使用了独立的管理机制（如 MCP 有自己的连接状态机），Store 只持有它们的引用，不对其内部变更做不可变性约束。这是一种务实的妥协——对每一层数据都强制不可变更新，在复杂嵌套结构中会产生大量样板代码，收益却不明显。

投机执行状态（SpeculationState）也被嵌入 AppState 中：

```typescript
// src/state/AppStateStore.ts:58-79
// SpeculationState 有两种形态：
// - idle：空闲状态，无投机执行
// - active：正在执行投机推理
// IDLE_SPECULATION_STATE 是 idle 形态的常量引用
```

将投机执行状态放在全局 Store 中，使得 UI 层可以直接感知投机执行的进度并展示反馈，而无需单独建立通信通道。

## 16.3 状态变更的完整流程

从用户操作到界面更新，状态变更经历了以下环节：

```
用户操作 / 工具执行结果
  |
  v
store.setState(prev => {
  // 基于旧状态计算新状态
  return { ...prev, field: newValue }
})
  |
  v
Object.is 检查
  |
  +-- 引用相同 --> 跳过，不做任何操作
  |
  +-- 引用不同 --> 继续
        |
        v
  更新内部 state 引用
        |
        v
  调用 onChange 回调
  （执行副作用：日志、级联更新等）
        |
        v
  遍历 listeners，逐个调用
        |
        v
  React 组件通过 useSyncExternalStore 感知变更
        |
        v
  触发组件重新渲染
```

整个流程是同步的——从 `setState` 调用到所有 listener 被通知，中间没有异步间隙。这保证了状态的一致性：任何在 `setState` 之后立即调用 `getState()` 的代码，一定能读到更新后的值。

## 16.4 Context 分发

状态存储在 Store 中，但组件如何访问它？`src/state/AppState.ts` 中的 `AppStateProvider` 将 Store 包装为 React Context：

```typescript
// src/state/AppState.ts
// AppStateProvider 通过 React.createContext 创建上下文
// 内部持有 Store 实例
// getAppState 和 setAppState 通过 Context 传递给子组件
// ToolUseContext 中也包含这两个方法，供工具实现访问状态
```

组件层面通过 `useContext` 或自定义 Hook 获取 `getAppState` 和 `setAppState`。工具层面则通过 `ToolUseContext`（传递给每个工具的执行上下文）获取这两个方法。这意味着无论是 React 组件还是非 React 的工具实现代码，都能以统一的方式读写状态。

这种设计有一个重要的架构意义：状态的所有权集中在 Store，但访问权通过 Context 分散到各处。Store 不需要知道谁在使用它——它只维护数据和通知机制。这与 Redux 的 `connect` 或 Zustand 的 `useStore` 思路一致，但实现上轻量得多。

## 16.5 与 Redux/Zustand 的比较

读者可能会问：为什么不用 Redux 或 Zustand 这些成熟的状态管理库？

Claude Code 的场景有两个特殊性。第一，它运行在 Node.js 终端环境中，不是浏览器。很多状态管理库假设了浏览器环境的存在（如 DevTools 集成、LocalStorage 持久化），这些在终端中毫无用处。第二，Claude Code 的状态结构相对扁平——一个 `AppState` 对象加上几个独立管理的子系统，不需要 Redux 的 reducer 组合、middleware 管道等复杂机制。

40 行代码的 `createStore` 提供了恰好够用的功能：不可变更新、引用相等性优化、订阅通知、副作用回调。它没有 action type 常量、没有 reducer 分片、没有 middleware 链——因为这些在 Claude Code 的场景中并不需要。这种"刚好够用"的设计哲学，在整个代码库中随处可见。

## 本章小结

Claude Code 的状态管理建立在一个不到 40 行的 `createStore` 函数之上。它通过 updater 函数模式保证不可变更新，通过 `Object.is` 跳过无效变更，通过 `onChange` 回调处理副作用，通过 `subscribe` 接口对接 React 的外部状态订阅机制。`AppState` 类型使用 `DeepImmutable` 在编译期强制不可变性约束，同时对内部结构复杂的子系统做了务实的豁免。状态通过 `AppStateProvider` 和 `ToolUseContext` 分发到 React 组件和工具实现两个消费层。整套方案没有引入任何第三方状态管理库，用最少的代码满足了所有需求——这本身就是对"什么时候不需要框架"这个问题的一个有力回答。
