import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
const workspace = '/home/ubuntu/dsh/feishu-workspace';
const harness = new DeepSeekHarness({
  launch: { command: '/tmp/run-runtime-debug.sh', args: ['--profile', 'feishu-agent'],
    env: { ...process.env, DSH_HOME: '/home/ubuntu/dsh/.dsh', HOME: '/home/ubuntu/dsh/.home',
      DSH_FEISHU_CLI_BIN: '/home/ubuntu/dsh/.lark-cli/node_modules/.bin/lark-cli',
      DSH_FEISHU_NOTIFY_URL: 'http://127.0.0.1:48680', DSH_FEISHU_NOTIFY_TOKEN: 'test-token' },
    cwd: workspace },
  cwd: workspace, provider: 'opencode-go', model: 'deepseek-v4-flash', maxTokens: 16384,
});
try {
  const result = await harness.run('调用 feishu_create_doc 工具创建文档，title="Agent测试5"，content="测试内容"。执行后报告结果。');
  const types = result.events.map((e) => e.type);
  console.log('EVENT_TYPES:', [...new Set(types)].join(','));
  console.log('HAS_TOOL_RESULT:', types.includes('tool/result'));
  console.log('FINAL:', JSON.stringify(result.finalResponse));
} finally { await harness.close(); }
