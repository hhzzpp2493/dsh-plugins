import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
const env = { ...process.env, DSH_HOME: '/home/ubuntu/dsh/.dsh', HOME: '/home/ubuntu/dsh/.home',
  DSH_FEISHU_CLI_BIN: '/home/ubuntu/dsh/.lark-cli/node_modules/.bin/lark-cli',
  DSH_FEISHU_NOTIFY_URL: 'http://127.0.0.1:48680', DSH_FEISHU_NOTIFY_TOKEN: 't' };
const harness = new DeepSeekHarness({
  launch: { command: 'node', args: ['/usr/bin/dsh', '--profile', 'feishu-agent'], env, cwd: '/home/ubuntu/dsh/feishu-workspace' },
  cwd: '/home/ubuntu/dsh/feishu-workspace', provider: 'opencode-go', model: 'deepseek-v4-flash', maxTokens: 8192,
});
const sid = 'seqtest:oc_3af6a0d67edc3161e03184cc047bbc06';
async function r(prompt, label) {
  try {
    const res = await Promise.race([
      harness.run(prompt, { sessionId: sid }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), 40000)),
    ]);
    console.log(label, '=> FINAL:', JSON.stringify(res.finalResponse?.slice(0, 30)));
  } catch (e) { console.log(label, '=>', e.message); }
}
await harness.start();
await r('回复：OK', 'run1');
await r('再回复：OK2', 'run2-same-session');
await harness.close();
