import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
const workspace = '/home/ubuntu/dsh/feishu-workspace';
const harness = new DeepSeekHarness({
  launch: { command: '/tmp/run-runtime-debug.sh', args: ['--profile', 'feishu-agent'],
    env: { ...process.env, DSH_HOME: '/home/ubuntu/dsh/.dsh', HOME: '/home/ubuntu/dsh/.home',
      DSH_FEISHU_CLI_BIN: '/home/ubuntu/dsh/.lark-cli/node_modules/.bin/lark-cli',
      DSH_FEISHU_NOTIFY_URL: 'http://127.0.0.1:48680', DSH_FEISHU_NOTIFY_TOKEN: 'test-token'},
    cwd: workspace },
  cwd: workspace, provider: 'opencode-go', model: 'deepseek-v4-flash', maxTokens: 16384,
});
try {
  const result = await harness.run('调用 feishu_create_doc 创建文档 title="Agent测试6" content="测试"。报告结果。');
  console.log('NOTIFICATION METHODS:', [...new Set(result.notifications.map((n) => n.method))].join(','));
  for (const n of result.notifications.filter((n) => /tool|error/i.test(n.method))) {
    console.log('NTFY', n.method, JSON.stringify(n.params).slice(0, 200));
  }
  console.log('FINAL:', JSON.stringify(result.finalResponse));
} finally { await harness.close(); }
