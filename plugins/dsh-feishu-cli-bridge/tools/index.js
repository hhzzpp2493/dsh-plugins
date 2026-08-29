// Cordis plugin loaded into the feishu runtime profile. Registers the dsh
// agent tools that let the agent talk back into Feishu and control Feishu
// Drive files through the official lark-cli.
import { basename, dirname, resolve as resolvePath } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runLarkCliAsync } from '../bridge/cli.js';

export const name = 'dsh-feishu-cli-tools';
export const inject = ['tools'];

function objArgs(rawArgs, tool) {
  if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) return rawArgs;
  throw new Error(`${tool}: arguments must be an object`);
}

function strArg(args, key, tool, { required = false } = {}) {
  const value = args[key];
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${tool}: missing required argument "${key}"`);
    return undefined;
  }
  if (typeof value !== 'string') throw new Error(`${tool}: "${key}" must be a string`);
  return value;
}

function text(name, textValue) {
  return [{ type: 'text', text: String(textValue) }];
}

/** Run lark-cli (async) and return its JSON output parsed, or the raw output on failure. */
async function cliJson(args, { cwd, timeoutMs = 120_000 } = {}) {
  const { stdout } = await runLarkCliAsync(args, { cwd, timeoutMs });
  try {
    return JSON.parse(stdout);
  } catch {
    return { raw: stdout };
  }
}

export function apply(ctx, config = {}) {
  const endpoint = config.endpoint ?? process.env.DSH_FEISHU_NOTIFY_URL;
  const token = config.token ?? process.env.DSH_FEISHU_NOTIFY_TOKEN;

  async function post(path, payload) {
    if (!endpoint || !token) {
      throw new Error(
        `${path} tool is not configured (DSH_FEISHU_NOTIFY_URL/TOKEN missing in runtime env)`,
      );
    }
    const response = await fetch(`${endpoint}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, ...payload }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok !== true) {
      throw new Error(body.error ?? `bridge ${path} failed (HTTP ${response.status})`);
    }
    return body;
  }

  ctx.tools.register({
    name: 'feishu_send_message',
    description:
      'Send a plain-text message into a Feishu chat (or direct message). The agent is chatting with a user in chat_id; use it to push messages, results or questions into that Feishu chat.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'chat_id'],
      properties: {
        text: { type: 'string', minLength: 1, description: 'Message text to send into Feishu.' },
        chat_id: { type: 'string', description: 'Feishu chat id (oc_...) to send to.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          chatId: { type: 'string' },
        },
      },
      render: (_args, raw) => text('feishu_send_message', raw.ok ? `sent to ${raw.chatId}` : 'send failed'),
    },
    async execute(rawArgs) {
      const args = objArgs(rawArgs, 'feishu_send_message');
      const textValue = strArg(args, 'text', 'feishu_send_message', { required: true });
      const chatId = strArg(args, 'chat_id', 'feishu_send_message', { required: true });
      const body = await post('/send', { text: textValue, chat_id: chatId });
      return { ok: true, chatId: body.chatId ?? chatId };
    },
  });

  ctx.tools.register({
    name: 'feishu_send_file',
    description:
      'Send a local file into a Feishu chat as a file attachment message. Use when the agent produced a file (report, archive, image, etc.) that the user should receive in the current Feishu chat.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['local_path', 'chat_id'],
      properties: {
        local_path: { type: 'string', description: 'Absolute path of the local file to send.' },
        chat_id: { type: 'string', description: 'Feishu chat id (oc_...) to send to.' },
        filename: { type: 'string', description: 'Optional display filename (default: local basename).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          chatId: { type: 'string' },
        },
      },
      render: (_args, raw) => text('feishu_send_file', raw.ok ? `file sent to ${raw.chatId}` : 'send failed'),
    },
    async execute(rawArgs) {
      const args = objArgs(rawArgs, 'feishu_send_file');
      const localPath = strArg(args, 'local_path', 'feishu_send_file', { required: true });
      const chatId = strArg(args, 'chat_id', 'feishu_send_file', { required: true });
      const filename = strArg(args, 'filename', 'feishu_send_file');
      const body = await post('/send-file', { local_path: localPath, chat_id: chatId, filename });
      return { ok: true, chatId: body.chatId ?? chatId };
    },
  });

  ctx.tools.register({
    name: 'feishu_drive_upload',
    description:
      'Upload a local file into the user\'s Feishu Drive (cloud storage). Returns the uploaded file token/type. Use before feishu_send_message to tell the user the file token or link.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['local_path'],
      properties: {
        local_path: { type: 'string', description: 'Absolute path of the local file to upload.' },
        folder_token: { type: 'string', description: 'Optional Drive folder token to upload into (default: Drive root).' },
        name: { type: 'string', description: 'Optional upload name (default: local basename).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          fileToken: { type: 'string' },
          fileName: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, raw) =>
        text(
          'feishu_drive_upload',
          raw.ok ? `uploaded ${raw.fileName ?? ''} (token ${raw.fileToken})` : `upload failed: ${raw.error}`,
        ),
    },
    async execute(rawArgs) {
      const args = objArgs(rawArgs, 'feishu_drive_upload');
      const localPath = strArg(args, 'local_path', 'feishu_drive_upload', { required: true });
      const folderToken = strArg(args, 'folder_token', 'feishu_drive_upload');
      const name = strArg(args, 'name', 'feishu_drive_upload');
      try {
        // lark-cli --file accepts only cwd-relative paths: run from the file's directory.
        const dir = dirname(localPath);
        const base = basename(localPath);
        const cliArgs = ['drive', '+upload', '--file', `./${base}`, '--as', 'user'];
        if (folderToken) cliArgs.push('--folder-token', folderToken);
        if (name) cliArgs.push('--name', name);
        const result = await cliJson(cliArgs, { cwd: dir, timeoutMs: 300_000 });
        const data = result?.data ?? result;
        const fileToken = data?.file_token ?? data?.token ?? data?.fileToken;
        return { ok: Boolean(fileToken), fileToken: fileToken ?? String(result?.raw ?? ''), fileName: name ?? base };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },
  });

  ctx.tools.register({
    name: 'feishu_drive_download',
    description:
      'Download a file from the user\'s Feishu Drive to local disk. Provide a Drive file token (or URL); the file is saved under the session workspace (cwd).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['file_token'],
      properties: {
        file_token: { type: 'string', description: 'Drive file token or share URL to download.' },
        output: { type: 'string', description: 'Optional relative output path (default: token-derived name in cwd).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          path: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, raw) =>
        text('feishu_drive_download', raw.ok ? `downloaded to ${raw.path}` : `download failed: ${raw.error}`),
    },
    async execute(rawArgs) {
      const args = objArgs(rawArgs, 'feishu_drive_download');
      const token = strArg(args, 'file_token', 'feishu_drive_download', { required: true });
      const output = strArg(args, 'output', 'feishu_drive_download');
      try {
        const cliArgs = ['drive', '+download', '--as', 'user'];
        if (token.startsWith('http')) cliArgs.push('--url', token);
        else cliArgs.push('--file-token', token);
        if (output) cliArgs.push('--output', output);
        const result = await cliJson(cliArgs, { timeoutMs: 300_000 });
        const data = result?.data ?? result;
        const saved = data?.saved_path ?? data?.path ?? data?.output ?? data?.file;
        return { ok: true, path: saved ?? output ?? token };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },
  });

  ctx.tools.register({
    name: 'feishu_drive_search',
    description:
      'Search the user\'s Feishu Drive / docs / wiki for files and documents by keyword. Useful to locate a file before download, upload or edit.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Search keyword(s).' },
        doc_types: {
          type: 'string',
          description: 'Optional comma-separated types: doc,sheet,bitable,mindnote,file,wiki,docx,folder,catalog,slides,shortcut',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          results: { type: 'string', description: 'Compact JSON of the search hits.' },
          error: { type: 'string' },
        },
      },
      render: (_args, raw) =>
        text('feishu_drive_search', raw.ok ? `search results: ${raw.results}` : `search failed: ${raw.error}`),
    },
    async execute(rawArgs) {
      const args = objArgs(rawArgs, 'feishu_drive_search');
      const query = strArg(args, 'query', 'feishu_drive_search', { required: true });
      const docTypes = strArg(args, 'doc_types', 'feishu_drive_search');
      try {
        const cliArgs = ['drive', '+search', '--query', query, '--as', 'user'];
        if (docTypes) cliArgs.push('--doc-types', docTypes);
        const result = await cliJson(cliArgs, { timeoutMs: 120_000 });
        const data = result?.data ?? result;
        const items = data?.results ?? data?.items ?? data?.entities ?? data?.docs ?? data;
        return { ok: true, results: JSON.stringify(items).slice(0, 20_000) };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },
  });

  ctx.tools.register({
    name: 'feishu_create_doc',
    description:
      'Create a new Feishu cloud document (docx) with the given title and Markdown content, optionally inside a Drive folder. Returns the doc token / URL.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['title'],
      properties: {
        title: { type: 'string', description: 'Document title.' },
        content: { type: 'string', description: 'Optional Markdown body.' },
        folder_token: { type: 'string', description: 'Optional parent Drive folder token (default: Drive root / my library).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          token: { type: 'string' },
          url: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, raw) =>
        text('feishu_create_doc', raw.ok ? `created doc ${raw.token} ${raw.url ?? ''}` : `create failed: ${raw.error}`),
    },
    async execute(rawArgs) {
      const args = objArgs(rawArgs, 'feishu_create_doc');
      const title = strArg(args, 'title', 'feishu_create_doc', { required: true });
      const content = strArg(args, 'content', 'feishu_create_doc');
      const folderToken = strArg(args, 'folder_token', 'feishu_create_doc');
      try {
        const cliArgs = ['docs', '+create', '--title', title, '--doc-format', 'markdown', '--as', 'user'];
        if (content) cliArgs.push('--content', content);
        if (folderToken) cliArgs.push('--parent-token', folderToken);
        const result = await cliJson(cliArgs, { timeoutMs: 120_000 });
        const data = result?.data ?? result;
        const doc = data?.document ?? data;
        const token = data?.token ?? doc?.document_id ?? data?.document_id ?? data?.doc_token ?? data?.file_token;
        const url = doc?.url ?? data?.url ?? data?.permalink;
        return { ok: Boolean(token), token: token ?? '', url: url ?? '' };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },
  });
}