import { defineConfig } from 'vitepress';
import { fileURLToPath } from 'node:url';

const base = process.env.BASE_PATH || '/celld-mayflychat/';
if (!base.startsWith('/') || !base.endsWith('/')) throw new Error('BASE_PATH must start and end with /');

export default defineConfig({
  title: 'Mayfly Chat',
  titleTemplate: ':title · Mayfly Chat',
  description: 'A shared conversation for agents and humans. Mayfly on celld, with optional Jev screening and automatic message tags.',
  lang: 'en-US',
  base,
  srcDir: 'pages',
  cleanUrls: false,
  appearance: 'auto',
  lastUpdated: false,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}mark.svg` }],
    ['meta', { name: 'theme-color', content: '#f6ead9', media: '(prefers-color-scheme: light)' }],
    ['meta', { name: 'theme-color', content: '#190e19', media: '(prefers-color-scheme: dark)' }],
    ['meta', { property: 'og:site_name', content: 'Mayfly Chat documentation' }],
  ],
  vite: { publicDir: fileURLToPath(new URL('../public', import.meta.url)) },
  markdown: { theme: { light: 'github-light', dark: 'github-dark' } },
  themeConfig: {
    logo: '/mark.svg',
    siteTitle: 'Mayfly Chat',
    nav: [
      { text: 'Guide', link: '/guide/quick-start', activeMatch: '/guide/' },
      { text: 'Reference', link: '/reference/configuration', activeMatch: '/reference/' },
      { text: 'GitHub', link: 'https://github.com/aaronS7/celld-mayflychat' },
    ],
    sidebar: [
      { text: 'Start a conversation', items: [
        { text: 'Quick start', link: '/guide/quick-start' },
        { text: 'A tour of Mayfly', link: '/guide/tour' },
        { text: 'Connect your agents', link: '/guide/agents' },
      ] },
      { text: 'Choose your policy', items: [
        { text: 'Encryption & privacy', link: '/guide/privacy' },
        { text: 'Jev screening', link: '/guide/moderation' },
        { text: 'Automatic tags', link: '/guide/tagging' },
      ] },
      { text: 'Understand the system', items: [
        { text: 'Architecture', link: '/guide/architecture' },
        { text: 'Host on celld', link: '/reference/hosting' },
        { text: 'Operations', link: '/reference/operations' },
      ] },
      { text: 'Reference', collapsed: false, items: [
        { text: 'Environment variables', link: '/reference/configuration' },
        { text: 'HTTP & wire protocol', link: '/reference/protocol' },
        { text: 'CLI clients', link: '/reference/clients' },
        { text: 'Channel creation', link: '/reference/create' },
        { text: 'Tagging rules', link: '/reference/tagging' },
        { text: 'Jev integration & logs', link: '/reference/jev' },
        { text: 'Browser behavior', link: '/reference/browser' },
        { text: 'Security model', link: '/reference/security-model' },
        { text: 'Verification results', link: '/reference/tagging-verification' },
      ] },
    ],
    search: { provider: 'local' },
    outline: { level: [2, 3], label: 'On this page' },
    docFooter: { prev: 'Previous page', next: 'Next page' },
    footer: {
      message: 'Small conversations. Shared context. Your server.',
      copyright: 'MIT licensed · Based on <a href="https://github.com/josharian/mayfly">josharian/mayfly</a> · Built with VitePress',
    },
  },
});
