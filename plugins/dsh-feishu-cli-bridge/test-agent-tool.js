// Agent tool end-to-end test v2: forces tool calls and logs notifications.
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import { writeFileSync } from 'node:fs';

const workspace = '/home/ubuntu/dsh/feishu-workspace';
writeFileSync('/home/ubuntu/dsh/feishu-workspace/agent-upload-test.txt', '由 dsh agent 工具上传的文件\n', 'utf8');

const harness = new DeepSeekHarness({
  launch: {
    command: 'node',
    args: ['/usr/bin/dsh', '--profile', 'feishu-agent'],
    env: {
      ...process.env,
      DSH_HOME: '/home/ubuntu/dsh/.dsh',
      HOME: '/home/ubuntu/dsh/.home',
      DSH_FEISHU_CLI_BIN: '/home/ubuntu/dsh/.lark-cli/node_modules/.bin/lark-cli',
      DSH_FEISHU_NOTIFY_URL: 'http://127.0.0.1:48680',
      DSH_FEISHU_NOTIFY_TOKEN: 'test-token',
    },
    cwd: workspace,
  },
  cwd: workspace,
  provider: 'opencode-go',
  model: 'deepseek-v4-flash',
  maxTokens: 16_384,
});

try {
  const prompt = [
    '这是一个强制工具调用测试。你必须真实调用以下两个工具（不要只描述意图，不要跳过）：',
    '步骤1：调用 feishu_create_doc，参数：title="桥接Agent工具测试2"，content 为 Markdown 文本 "## 测试\\n这是由 dsh agent 通过官方 CLI 工具创建的文档。"',
    '步骤2：调用 feishu_drive_upload，参数：local_path="/home/ubuntu/dsh/feishu-workspace/agent-upload-test.txt"（不要指定 folder_token）。',
    '步骤3：调用 feishu_drive_search，参数：query="桥接Agent工具测试2"。',
    '全部完成后，用一句话报告每个工具的返回结果。',
  ].join('\n');
  const result = await harness.run(prompt, {
    onNotification: (n) => console.log('NTFY:', n.method),
  });
  console.log('SESSION:', result.sessionId);
  console.log('EVENTS:', result.events.length, 'last types:', result.events.slice(-5).map((e) => e.type).join(','));
  console.log('FINAL:', JSON.stringify(result.finalResponse));
} finally {
  await harness.close();
  console.log('CLOSED');
}