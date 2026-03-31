import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Claude Code 源码解析',
  description: 'Anthropic 官方 CLI 完整源码深度解读',
  lang: 'zh-CN',
  base: '/',

  head: [
    ['link', { rel: 'icon', href: '/logo.png' }],
    ['style', {}, `
      :root {
        --vp-c-brand-1: #da7756;
        --vp-c-brand-2: #c4684a;
        --vp-c-brand-3: #b55d41;
        --vp-c-brand-soft: rgba(218, 119, 86, 0.14);
        --vp-home-hero-name-color: transparent;
        --vp-home-hero-name-background: linear-gradient(135deg, #da7756 0%, #c4684a 100%);
        --vp-home-hero-image-background-image: linear-gradient(135deg, rgba(218,119,86,0.2) 0%, rgba(196,104,74,0.2) 100%);
        --vp-home-hero-image-filter: blur(56px);
        --vp-button-brand-bg: #da7756;
        --vp-button-brand-hover-bg: #c4684a;
        --vp-button-brand-active-bg: #b55d41;
        --vp-c-tip-1: #da7756;
        --vp-c-tip-2: rgba(218, 119, 86, 0.14);
        --vp-c-tip-3: rgba(218, 119, 86, 0.08);
      }
    `],
  ],

  themeConfig: {
    logo: '/logo.png',
    siteTitle: 'Claude Code 源码解析',

    nav: [
      { text: '首页', link: '/' },
      { text: '开始阅读', link: '/chapters/01-overview' },
      {
        text: '附录',
        items: [
          { text: '推荐阅读路径', link: '/chapters/appendix-a' },
          { text: '核心类型速查', link: '/chapters/appendix-b' },
          { text: '名词解释', link: '/chapters/appendix-c' },
        ],
      },
      { text: 'GitHub', link: 'https://github.com/coolclaws/claude-code-leaked-book' },
    ],

    sidebar: [
      {
        text: '第一部分：宏观认知',
        collapsed: false,
        items: [
          { text: '第 1 章 全局概览', link: '/chapters/01-overview' },
          { text: '第 2 章 Repo 结构导览', link: '/chapters/02-repo-structure' },
        ],
      },
      {
        text: '第二部分：启动与初始化',
        collapsed: false,
        items: [
          { text: '第 3 章 启动序列', link: '/chapters/03-startup' },
          { text: '第 4 章 配置系统', link: '/chapters/04-config' },
          { text: '第 5 章 认证系统', link: '/chapters/05-auth' },
        ],
      },
      {
        text: '第三部分：核心运行时',
        collapsed: false,
        items: [
          { text: '第 6 章 Query Engine', link: '/chapters/06-query-engine' },
          { text: '第 7 章 Tool System', link: '/chapters/07-tool-system' },
          { text: '第 8 章 Command System', link: '/chapters/08-command-system' },
        ],
      },
      {
        text: '第四部分：工具实现深度解析',
        collapsed: false,
        items: [
          { text: '第 9 章 文件操作工具', link: '/chapters/09-file-tools' },
          { text: '第 10 章 Shell 执行工具', link: '/chapters/10-shell-tools' },
          { text: '第 11 章 搜索与发现工具', link: '/chapters/11-search-tools' },
        ],
      },
      {
        text: '第五部分：Agent 编排系统',
        collapsed: false,
        items: [
          { text: '第 12 章 AgentTool 与子 Agent', link: '/chapters/12-agent-tool' },
          { text: '第 13 章 Team 与 Task 系统', link: '/chapters/13-team-task' },
          { text: '第 14 章 Bridge 系统', link: '/chapters/14-bridge' },
        ],
      },
      {
        text: '第六部分：UI 与交互',
        collapsed: false,
        items: [
          { text: '第 15 章 React Ink 终端 UI', link: '/chapters/15-ink-ui' },
          { text: '第 16 章 状态管理', link: '/chapters/16-state-management' },
          { text: '第 17 章 权限与确认系统', link: '/chapters/17-permissions' },
        ],
      },
      {
        text: '第七部分：高级特性',
        collapsed: false,
        items: [
          { text: '第 18 章 MCP 集成', link: '/chapters/18-mcp' },
          { text: '第 19 章 Skills 系统', link: '/chapters/19-skills' },
          { text: '第 20 章 记忆与会话', link: '/chapters/20-memory' },
        ],
      },
      {
        text: '第八部分：工程实践',
        collapsed: false,
        items: [
          { text: '第 21 章 性能与启动优化', link: '/chapters/21-performance' },
          { text: '第 22 章 可观测性与调试', link: '/chapters/22-observability' },
        ],
      },
      {
        text: '附录',
        collapsed: false,
        items: [
          { text: '附录 A 推荐阅读路径', link: '/chapters/appendix-a' },
          { text: '附录 B 核心类型速查', link: '/chapters/appendix-b' },
          { text: '附录 C 名词解释', link: '/chapters/appendix-c' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/coolclaws/claude-code-leaked-book' },
    ],

    editLink: {
      pattern: 'https://github.com/coolclaws/claude-code-leaked-book/edit/main/:path',
      text: '在 GitHub 上编辑此页',
    },

    footer: {
      message: '本书基于泄露源码编写，仅供学习研究',
      copyright: 'Claude Code 源码解析 © 2025',
    },

    outline: {
      level: [2, 3],
      label: '本页目录',
    },

    docFooter: {
      prev: '上一章',
      next: '下一章',
    },

    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索', buttonAriaLabel: '搜索' },
          modal: {
            noResultsText: '未找到结果',
            resetButtonTitle: '清除查询',
            footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
          },
        },
      },
    },
  },
})
