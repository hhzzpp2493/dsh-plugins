import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
const launchEnv = {
  ...process.env,
  DSH_HOME: '/home/ubuntu/dsh/.dsh',
  HOME: '/home/ubuntu/dsh/.home',
  XDG_CONFIG_HOME: '/home/ubuntu/dsh/.xdg/config',
  XDG_DATA_HOME: '/home/ubuntu/dsh/.xdg/data',
  DSH_FEISHU_HOST_PROFILE: 'feishu-bridge',
  DSH_FEISHU_PROFILE: 'feishu-agent',
  DSH_FEISHU_DSH_BIN: '/usr/bin/dsh',
  DSH_FEISHU_WORKSPACE: '/home/ubuntu/dsh/feishu-workspace',
  DSH_FEISHU_MEDIA_DIR: '/home/ubuntu/dsh/feishu-media',
  DSH_FEISHU_CLI_BIN: '/home/ubuntu/dsh/.lark-cli/node_modules/.bin/lark-cli',
  DSH_FEISHU_PROVIDER: 'opencode-go',
  DSH_FEISHU_MODEL: 'deepseek-v4-flash',
  DSH_FEISHU_NOTIFY_PORT: '48680',
  DSH_FEISHU_ACK: '1',
  DSH_FEISHU_NOTIFY_URL: 'http://127.0.0.1:48680',
  DSH_FEISHU_NOTIFY_TOKEN: 't',
};
const harness = new DeepSeekHarness({
  launch: { command: 'node', args: ['/usr/bin/dsh', '--profile', 'feishu-agent'],
    env: launchEnv, cwd: '/home/ubuntu/dsh/feishu-workspace' },
  cwd: '/home/ubuntu/dsh/feishu-workspace', provider: 'opencode-go', model: 'deepseek-v4-flash', maxTokens: 8192,
});
try {
  await harness.start();
  console.log('handshake ok');
  const result = await Promise.race([
    harness.run('回复两个字：在的', { sessionId: 'feishu2:oc_3af6a0d67edc3161e03184cc047bbc06' }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('RUN_TIMEOUT_50s')), 50000)),
  ]);
  console.log('FINAL:', JSON.stringify(result.finalResponse?.slice(0, 40)));
} catch (e) { console.log('ERROR:', e.message); }
finally { await harness.close(); }
