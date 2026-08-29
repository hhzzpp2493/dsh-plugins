import { runLarkCliAsync } from './bridge/cli.js';
process.env.HOME = '/home/ubuntu/dsh/.home';
process.env.DSH_FEISHU_CLI_BIN = '/home/ubuntu/dsh/.lark-cli/node_modules/.bin/lark-cli';
process.env.XDG_CONFIG_HOME = '/home/ubuntu/dsh/.xdg/config';
const r = await runLarkCliAsync(['drive', '+search', '--query', '桥接', '--as', 'user'], { timeoutMs: 60000 });
console.log('ASYNC_CLI_OK, stdout head:', r.stdout.slice(0, 80));
