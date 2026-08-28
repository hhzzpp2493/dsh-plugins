// Smoke test 2: verify the agent can see the feishu_* tools in the runtime.
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';

const workspace = '/home/ubuntu/dsh/feishu-workspace';
const harness = new DeepSeekHarness({
  launch: {
    command: 'node',
    args: ['/usr/bin/dsh', '--profile', 'feishu-bridge'],
    env: { ...process.env, DSH_HOME: '/home/ubuntu/dsh/.dsh' },
    cwd: workspace,
  },
  cwd: workspace,
  provider: 'opencode-go',
  model: 'deepseek-v4-flash',
  maxTokens: 8192,
});

try {
  const result = await harness.run(
    'Reply with ONLY the names of any tools available to you whose name contains "feishu", one per line. If none, reply NONE.',
  );
  console.log('FINAL_RESPONSE:', JSON.stringify(result.finalResponse));
} finally {
  await harness.close();
  console.log('CLOSED');
}