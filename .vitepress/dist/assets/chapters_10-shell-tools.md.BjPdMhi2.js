import{_ as a,o as n,c as p,ag as e}from"./chunks/framework.CvgP6Fyv.js";const k=JSON.parse('{"title":"第 10 章 Shell 执行工具","description":"","frontmatter":{},"headers":[],"relativePath":"chapters/10-shell-tools.md","filePath":"chapters/10-shell-tools.md"}'),l={name:"chapters/10-shell-tools.md"};function i(o,s,t,c,h,d){return n(),p("div",null,[...s[0]||(s[0]=[e(`<h1 id="第-10-章-shell-执行工具" tabindex="-1">第 10 章 Shell 执行工具 <a class="header-anchor" href="#第-10-章-shell-执行工具" aria-label="Permalink to &quot;第 10 章 Shell 执行工具&quot;">​</a></h1><blockquote><p>&quot;给程序一个 shell，它能做任何事；给程序一个沙箱里的 shell，它能安全地做任何事。&quot; —— 改编自 Alan Perlis</p></blockquote><p>Shell 执行是 Claude Code 最强大也最危险的能力。一条 <code>rm -rf /</code> 就足以摧毁整个系统，因此 BashTool 的设计在&quot;能力&quot;与&quot;约束&quot;之间进行了极其精细的平衡。本章将深入分析 BashTool 的安全沙箱机制、命令分类体系以及执行管理策略。</p><h2 id="_10-1-命令分类体系" tabindex="-1">10.1 命令分类体系 <a class="header-anchor" href="#_10-1-命令分类体系" aria-label="Permalink to &quot;10.1 命令分类体系&quot;">​</a></h2><p>BashTool 的实现位于 <code>src/tools/BashTool/BashTool.tsx</code>。在其文件开头，定义了一套精心设计的命令分类常量：</p><div class="language-typescript vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">typescript</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0"><code><span class="line"><span style="--shiki-light:#6A737D;--shiki-dark:#6A737D;">// src/tools/BashTool/BashTool.tsx, Lines 54-81</span></span>
<span class="line"><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF;">PROGRESS_THRESHOLD_MS</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583;"> =</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF;"> 2000</span></span>
<span class="line"><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF;">BASH_SEARCH_COMMANDS</span><span style="--shiki-light:#6A737D;--shiki-dark:#6A737D;">  // Set: grep, find, rg, ag, fd, locate ...</span></span>
<span class="line"><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF;">BASH_READ_COMMANDS</span><span style="--shiki-light:#6A737D;--shiki-dark:#6A737D;">    // Set: cat, head, tail, less, more ...</span></span>
<span class="line"><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF;">BASH_LIST_COMMANDS</span><span style="--shiki-light:#6A737D;--shiki-dark:#6A737D;">    // Set: ls, tree, du, df, file ...</span></span>
<span class="line"><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF;">BASH_SEMANTIC_NEUTRAL_COMMANDS</span><span style="--shiki-light:#6A737D;--shiki-dark:#6A737D;">  // Set: echo, printf ...</span></span>
<span class="line"><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF;">BASH_SILENT_COMMANDS</span><span style="--shiki-light:#6A737D;--shiki-dark:#6A737D;">  // Set: cd, pwd ...</span></span></code></pre></div><p>这五个分类构成了 BashTool 理解命令语义的基础。每一类命令具有不同的风险等级和行为特征：</p><p><strong>搜索命令</strong>（BASH_SEARCH_COMMANDS）包括 <code>grep</code>、<code>find</code>、<code>rg</code> 等，它们只读取文件系统的元数据或内容，不产生副作用。<strong>读取命令</strong>（BASH_READ_COMMANDS）如 <code>cat</code>、<code>head</code>、<code>tail</code>，同样是只读操作。<strong>列表命令</strong>（BASH_LIST_COMMANDS）用于浏览目录结构。<strong>语义中性命令</strong>（BASH_SEMANTIC_NEUTRAL_COMMANDS）如 <code>echo</code>、<code>printf</code>，其行为完全取决于参数。<strong>静默命令</strong>（BASH_SILENT_COMMANDS）如 <code>cd</code>、<code>pwd</code>，几乎没有可观测的副作用。</p><div class="language-typescript vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">typescript</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0"><code><span class="line"><span style="--shiki-light:#6A737D;--shiki-dark:#6A737D;">// src/tools/BashTool/BashTool.tsx, Lines 95-99</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583;">function</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0;"> isSearchOrReadBashCommand</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">(</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70;">command</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583;">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF;"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">)</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583;">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF;"> boolean</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;"> {</span></span>
<span class="line"><span style="--shiki-light:#6A737D;--shiki-dark:#6A737D;">  // 判断命令是否属于搜索或读取类别</span></span>
<span class="line"><span style="--shiki-light:#6A737D;--shiki-dark:#6A737D;">  // 用于决定是否需要权限检查</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">}</span></span></code></pre></div><p><code>isSearchOrReadBashCommand()</code> 函数是权限系统的第一道过滤器。如果一条命令被识别为纯粹的搜索或读取操作，它可以跳过某些权限检查环节，从而提供更流畅的使用体验。</p><p><code>PROGRESS_THRESHOLD_MS</code> 设定为 2000 毫秒，这意味着执行时间超过 2 秒的命令会触发进度报告机制，让用户了解命令仍在执行中而非卡死。</p><h2 id="_10-2-输入参数与执行控制" tabindex="-1">10.2 输入参数与执行控制 <a class="header-anchor" href="#_10-2-输入参数与执行控制" aria-label="Permalink to &quot;10.2 输入参数与执行控制&quot;">​</a></h2><p>BashTool 的输入参数设计反映了对各种使用场景的考量：</p><ul><li><strong>command</strong>：要执行的 shell 命令，必填</li><li><strong>timeout</strong>：超时时间，可选，最大值 600000 毫秒（10 分钟）</li><li><strong>description</strong>：命令描述，帮助理解命令意图</li><li><strong>run_in_background</strong>：是否在后台执行</li><li><strong>dangerouslyDisableSandbox</strong>：危险选项，禁用沙箱</li></ul><p><code>run_in_background</code> 参数的存在解决了一个实际问题：某些命令（如启动开发服务器）需要长时间运行，如果同步等待会阻塞整个对话流程。后台执行模式允许命令在独立进程中运行，LLM 可以继续处理其他任务，稍后再检查结果。</p><p>超时机制是另一重要的安全保障。默认超时为 120 秒，最大允许 600 秒。超时后进程会被强制终止，防止失控命令无限期占用系统资源。</p><h2 id="_10-3-bash-ast-解析与安全分析" tabindex="-1">10.3 Bash AST 解析与安全分析 <a class="header-anchor" href="#_10-3-bash-ast-解析与安全分析" aria-label="Permalink to &quot;10.3 Bash AST 解析与安全分析&quot;">​</a></h2><p>在命令被执行之前，BashTool 会对其进行语法层面的分析：</p><div class="language- vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang"></span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0"><code><span class="line"><span>命令安全分析流程</span></span>
<span class="line"><span></span></span>
<span class="line"><span>BashTool.call({ command, timeout, description })</span></span>
<span class="line"><span>  |</span></span>
<span class="line"><span>  +-- Bash AST 解析 (src/utils/bash/ast.ts)</span></span>
<span class="line"><span>  |     +-- 解析命令为抽象语法树</span></span>
<span class="line"><span>  |     +-- 识别管道、重定向、子命令</span></span>
<span class="line"><span>  |     +-- 提取所有涉及的可执行文件名</span></span>
<span class="line"><span>  |</span></span>
<span class="line"><span>  +-- 命令拆分 (src/utils/bash/commands.ts)</span></span>
<span class="line"><span>  |     +-- 分离管道链中的各个命令</span></span>
<span class="line"><span>  |     +-- 识别 &amp;&amp; 和 || 连接的命令序列</span></span>
<span class="line"><span>  |</span></span>
<span class="line"><span>  +-- 权限检查 (bashPermissions.ts)</span></span>
<span class="line"><span>  |     +-- 只读命令 -&gt; 自动放行</span></span>
<span class="line"><span>  |     +-- 已授权命令 -&gt; 放行</span></span>
<span class="line"><span>  |     +-- 未知命令 -&gt; 请求用户授权</span></span>
<span class="line"><span>  |     +-- 危险命令 -&gt; 拒绝或警告</span></span>
<span class="line"><span>  |</span></span>
<span class="line"><span>  +-- 进入执行阶段</span></span></code></pre></div><p><code>src/utils/bash/ast.ts</code> 实现了 Bash 命令的 AST（抽象语法树）解析。这不是简单的字符串分割——它能正确处理管道（<code>|</code>）、逻辑连接符（<code>&amp;&amp;</code>、<code>||</code>）、子 shell（<code>$(...)</code>)、重定向（<code>&gt;</code>、<code>&gt;&gt;</code>）等复杂语法结构。</p><p>通过 AST 解析，系统可以从一条复合命令中提取出所有实际要执行的程序。比如对于 <code>find . -name &quot;*.ts&quot; | xargs grep &quot;TODO&quot; &gt; output.txt</code> 这条命令，AST 分析会识别出三个关键元素：<code>find</code>（搜索命令）、<code>xargs</code>（需要进一步分析其参数）和 <code>grep</code>（搜索命令），以及一个文件重定向操作。</p><h2 id="_10-4-权限系统" tabindex="-1">10.4 权限系统 <a class="header-anchor" href="#_10-4-权限系统" aria-label="Permalink to &quot;10.4 权限系统&quot;">​</a></h2><p>权限检查的核心逻辑位于 <code>src/tools/BashTool/bashPermissions.ts</code>。这个模块决定一条命令是否需要用户的明确授权：</p><p>对于被分类为搜索或读取类型的命令，系统通常会自动放行，因为它们不会修改文件系统状态。而涉及写入、删除或系统管理的命令则需要经过权限审核。</p><p>权限系统还支持&quot;记忆&quot;机制——用户授权过一次的命令模式，在同一会话中不需要再次确认。这在重复执行类似命令时（比如多次运行测试套件）极大地改善了交互体验。</p><h2 id="_10-5-沙箱机制" tabindex="-1">10.5 沙箱机制 <a class="header-anchor" href="#_10-5-沙箱机制" aria-label="Permalink to &quot;10.5 沙箱机制&quot;">​</a></h2><p>沙箱是 BashTool 最核心的安全基础设施，其实现位于 <code>src/utils/sandbox/sandbox-adapter.ts</code>：</p><div class="language- vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang"></span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0"><code><span class="line"><span>沙箱适配层</span></span>
<span class="line"><span></span></span>
<span class="line"><span>sandbox-adapter.ts</span></span>
<span class="line"><span>  |</span></span>
<span class="line"><span>  +-- 检测操作系统</span></span>
<span class="line"><span>  |</span></span>
<span class="line"><span>  +-- macOS 分支</span></span>
<span class="line"><span>  |     +-- 使用 sandbox-exec 系统调用</span></span>
<span class="line"><span>  |     +-- 加载预定义的沙箱配置文件</span></span>
<span class="line"><span>  |     +-- 限制文件系统访问范围</span></span>
<span class="line"><span>  |     +-- 限制网络访问能力</span></span>
<span class="line"><span>  |</span></span>
<span class="line"><span>  +-- Linux 分支</span></span>
<span class="line"><span>  |     +-- 使用 seccomp / namespace 隔离</span></span>
<span class="line"><span>  |     +-- 限制系统调用集合</span></span>
<span class="line"><span>  |     +-- 文件系统命名空间隔离</span></span>
<span class="line"><span>  |</span></span>
<span class="line"><span>  +-- dangerouslyDisableSandbox=true</span></span>
<span class="line"><span>        +-- 跳过所有沙箱限制</span></span>
<span class="line"><span>        +-- 以当前用户权限直接执行</span></span></code></pre></div><p>在 macOS 上，沙箱利用了系统内置的 <code>sandbox-exec</code> 机制。这是 Apple 提供的应用沙箱技术，可以通过配置文件精确控制进程能够访问的文件路径、网络端口和系统调用。</p><p>在 Linux 上，沙箱采用了 seccomp（安全计算模式）和 namespace（命名空间）两种内核级隔离技术。seccomp 可以限制进程能使用的系统调用集合，而 namespace 则创建了一个隔离的文件系统视图，使得进程只能看到被允许的路径。</p><p><code>dangerouslyDisableSandbox</code> 参数的命名用了 &quot;dangerously&quot; 前缀，这是一个经典的 API 设计策略——通过命名本身传达风险信号。在实际使用中，只有当沙箱限制干扰了合法操作（如需要访问特殊设备文件）时，才应该使用这个选项。</p><h2 id="_10-6-执行过程管理" tabindex="-1">10.6 执行过程管理 <a class="header-anchor" href="#_10-6-执行过程管理" aria-label="Permalink to &quot;10.6 执行过程管理&quot;">​</a></h2><p>命令通过权限检查和沙箱包装后，进入实际执行阶段。Shell 执行的核心封装位于 <code>src/utils/Shell.ts</code>：</p><div class="language- vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang"></span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0"><code><span class="line"><span>进程生命周期</span></span>
<span class="line"><span></span></span>
<span class="line"><span>Shell.execute(command, options)</span></span>
<span class="line"><span>  |</span></span>
<span class="line"><span>  +-- 创建子进程 (child_process.spawn)</span></span>
<span class="line"><span>  +-- 注册 stdout/stderr 流处理器</span></span>
<span class="line"><span>  |     +-- 实时收集输出</span></span>
<span class="line"><span>  |     +-- 超过 PROGRESS_THRESHOLD_MS 时报告进度</span></span>
<span class="line"><span>  |</span></span>
<span class="line"><span>  +-- 等待进程结束</span></span>
<span class="line"><span>  |     +-- 正常退出 -&gt; 收集 exitCode</span></span>
<span class="line"><span>  |     +-- 超时 -&gt; 发送 SIGTERM, 等待, SIGKILL</span></span>
<span class="line"><span>  |     +-- 异常 -&gt; 捕获错误信息</span></span>
<span class="line"><span>  |</span></span>
<span class="line"><span>  +-- 返回 { stdout, stderr, exitCode }</span></span></code></pre></div><p>超时处理采用了两阶段终止策略：首先发送 SIGTERM 信号，给进程一个优雅退出的机会；如果进程在宽限期内没有响应，则发送 SIGKILL 强制终止。这种策略确保了即使遇到僵死进程，系统也不会被永久阻塞。</p><h2 id="_10-7-powershelltool" tabindex="-1">10.7 PowerShellTool <a class="header-anchor" href="#_10-7-powershelltool" aria-label="Permalink to &quot;10.7 PowerShellTool&quot;">​</a></h2><p>对于 Windows 平台，Claude Code 提供了 PowerShellTool 作为 BashTool 的对应物。它遵循与 BashTool 相同的安全模型——命令分类、权限检查、沙箱隔离——但底层使用 PowerShell 引擎执行命令。这种平台特化的设计确保了 Claude Code 在不同操作系统上都能提供一致的功能体验。</p><h2 id="本章小结" tabindex="-1">本章小结 <a class="header-anchor" href="#本章小结" aria-label="Permalink to &quot;本章小结&quot;">​</a></h2><p>BashTool 的设计展现了&quot;最小权限原则&quot;在实际工程中的应用。命令分类体系为自动化的权限决策提供了语义基础，AST 解析使得安全分析能够深入到命令的结构层面而非停留在表面的字符串匹配，多层沙箱机制则在操作系统内核层面构建了最后一道防线。这套安全体系的核心思想是：与其在出问题后补救，不如在执行前就确认操作的安全性。这也是 Claude Code 能够被授予 shell 访问权限的根本原因——不是因为信任 LLM 永远不会出错，而是因为即使出错，损害也被严格限制在可控范围内。</p>`,39)])])}const g=a(l,[["render",i]]);export{k as __pageData,g as default};
