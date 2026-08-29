// Smoke test: boot the feishu-bridge runtime via the SDK client and run one
// model turn. Does not require Feishu auth.
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';

const workspace = process.env.DSH_FEISHU_WORKSPACE ?? '/home/ubuntu/dsh/feishu-workspace';
const harness = new DeepSeekHarness({
  launch: {
    command: 'node',
    args: ['/usr/bin/dsh', '--profile', 'feishu-agent'],
    env: { ...process.env, DSH_HOME: '/home/ubuntu/dsh/.dsh' },
    cwd: workspace,
  },
  cwd: workspace,
  provider: process.env.DSH_FEISHU_PROVIDER ?? 'opencode-go',
  model: process.env.DSH_FEISHU_MODEL ?? 'deepseek-v4-flash',
  maxTokens: 8192,
});

try {
  const t0 = Date.now();
  const result = await harness.run('Reply with exactly one line: BOOT-OK');
  console.log('ELAPSED_MS:', Date.now() - t0);
  console.log('SESSION_ID:', result.sessionId);
  console.log('FINAL_RESPONSE:', JSON.stringify(result.finalResponse));
} finally {
  await harness.close();
  console.log('CLOSED');
}