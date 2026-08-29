// Outbound Feishu/Lark messaging through `lark-cli im +messages-send`.
import { basename, dirname } from 'node:path';
import { runLarkCli } from './cli.js';

export class FeishuSender {
  constructor({ identity = 'bot' } = {}) {
    this.identity = identity;
  }

  /** Send a plain text message to a chat (oc_...) as the bot identity. */
  sendMessage(chatId, text) {
    const { stdout } = runLarkCli(
      ['im', '+messages-send', '--chat-id', chatId, '--text', text, '--as', this.identity],
      { timeoutMs: 60_000 },
    );
    return stdout;
  }

  /**
   * Send a local file as an attachment message.
   * Note: `im +messages-send --file` only accepts cwd-relative paths, so we
   * run the CLI from the file's directory and pass `./<name>`.
   */
  sendFile(chatId, localPath, { filename } = {}) {
    const name = filename ?? basename(localPath);
    const dir = dirname(localPath);
    const { stdout } = runLarkCli(
      ['im', '+messages-send', '--chat-id', chatId, '--file', `./${name}`, '--as', this.identity],
      { cwd: dir, timeoutMs: 180_000 },
    );
    return stdout;
  }

  /** Download an image/file resource from a message into a local directory. Returns the saved path. */
  downloadResource(messageId, fileKey, type, outputDir) {
    const { stdout } = runLarkCli(
      [
        'im', '+messages-resources-download',
        '--message-id', messageId,
        '--file-key', fileKey,
        '--type', type, // image | file
        '--output', fileKey,
        '--as', this.identity,
      ],
      { cwd: outputDir, timeoutMs: 120_000 },
    );
    // The CLI prints the saved path in JSON; fall back to our naming.
    try {
      const parsed = JSON.parse(stdout);
      const saved = parsed?.saved_path ?? parsed?.path ?? parsed?.output ?? parsed?.file;
      if (typeof saved === 'string' && saved.length > 0) return saved;
    } catch {
      // not JSON output
    }
    return fileKey;
  }
}