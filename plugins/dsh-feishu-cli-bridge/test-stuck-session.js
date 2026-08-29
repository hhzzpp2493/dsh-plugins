import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
const workspace = '/home/ubuntu/dsh/feishu-workspace';
async function trySession(sid, label) {
  const harness = new DeepSeekHarness({
    launch: { command: 'node', args: ['/usr/bin/dsh', '--profile', 'feishu-agent'],
      env: { ...process.env, DSH_HOME: '/home/ubuntu/dsh/.dsh', HOME: '/home/ubuntu/dsh/.home',
        DSH_FEISHU_CLI_BIN: '/home/ubuntu/dsh/.lark-cli/node_modules/.bin/lark-cli',
        DSH_FEISHU_NOTIFY_URL: 'http://127.0.0.1:48680', DSH_FEISHU_NOTIFY_TOKEN: 't' },
      cwd: workspace },
    cwd: workspace, provider: 'opencode-go', model: 'deepseek-v4-flash', maxTokens: 8192,
  });
  try {
    await harness.start();
    console.log(`[${label}] handshake ok`);
    const result = await Promise.race([
      harness.run('回复两个字：在的', { sessionId: sid }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('RUN_TIMEOUT_60s')), 60000)),
    ]);
    console.log(`[${label}] FINAL:`, JSON.stringify(result.finalResponse?.slice(0, 40)));
  } catch (e) {
    console.log(`[${label}] ERROR: ${e.message}`);
  } finally { await harness.close(); }
}
await trySession('feishu:oc_3af6a0d67edc3161e03184cc047bbc06', 'OLD_ID');
await trySession('feishu2:oc_3af6a0d67edc3161e03184cc047bbc06', 'NEW_ID');
