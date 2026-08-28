import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
const base = { ...process.env, DSH_HOME: '/home/ubuntu/dsh/.dsh', HOME: '/home/ubuntu/dsh/.home',
  DSH_FEISHU_CLI_BIN: '/home/ubuntu/dsh/.lark-cli/node_modules/.bin/lark-cli',
  DSH_FEISHU_NOTIFY_URL: 'http://127.0.0.1:48680', DSH_FEISHU_NOTIFY_TOKEN: 't' };
const groups = {
  XDG: { XDG_CONFIG_HOME: '/home/ubuntu/dsh/.xdg/config', XDG_DATA_HOME: '/home/ubuntu/dsh/.xdg/data' },
  FEISHU: { DSH_FEISHU_HOST_PROFILE: 'feishu-bridge', DSH_FEISHU_PROFILE: 'feishu-agent', DSH_FEISHU_DSH_BIN: '/usr/bin/dsh',
    DSH_FEISHU_WORKSPACE: '/home/ubuntu/dsh/feishu-workspace', DSH_FEISHU_MEDIA_DIR: '/home/ubuntu/dsh/feishu-media',
    DSH_FEISHU_PROVIDER: 'opencode-go', DSH_FEISHU_MODEL: 'deepseek-v4-flash',
    DSH_FEISHU_NOTIFY_PORT: '48680', DSH_FEISHU_ACK: '1' },
};
async function go(label, env) {
  const harness = new DeepSeekHarness({
    launch: { command: 'node', args: ['/usr/bin/dsh', '--profile', 'feishu-agent'], env, cwd: '/home/ubuntu/dsh/feishu-workspace' },
    cwd: '/home/ubuntu/dsh/feishu-workspace', provider: 'opencode-go', model: 'deepseek-v4-flash', maxTokens: 2048,
  });
  try {
    await harness.start();
    const r = await Promise.race([
      harness.run('回复：OK', { sessionId: `bisect:${label}` }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), 40000)),
    ]);
    console.log(label, '=> FINAL:', JSON.stringify(r.finalResponse?.slice(0, 20)));
  } catch (e) { console.log(label, '=>', e.message); }
  finally { await harness.close(); }
}
await go('base', base);
await go('base+XGD', { ...base, ...groups.XDG });
await go('base+FEISHU', { ...base, ...groups.FEISHU });
await go('base+XGD+FEISHU', { ...base, ...groups.XDG, ...groups.FEISHU });
