import SimpleCommand from "../../struct/commands/SimpleCommand";
import logger from "../logger";
import { client, dbs } from "../../index";
import fs from 'fs';
import path from 'path';
import { antispam } from "./antispam";
import checkCustomRules from "./custom_rules/custom_rules";
import MessageCommandContext from "../../struct/MessageCommandContext";
import { fileURLToPath } from 'url';
import { getOwnMemberInServer, hasPermForChannel } from "../util";
import { isSudo, updateSudoTimeout } from "../commands/admin/botadm";
import { metrics } from "./metrics";

// thanks a lot esm
const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

const ownerIDs = process.env['BOT_OWNERS'] ? process.env['BOT_OWNERS'].split(',') : [];
const DEFAULT_PREFIX = process.env['PREFIX']
                    ?? process.env['BOT_PREFIX']
                    ?? process.env['COMMAND_PREFIX']
                    ?? '/';

let commands: SimpleCommand[];

(async () => {
    commands = (await Promise.all(
        dirTreeSync(path.join(dirname, '..', 'commands'))
            .filter(file => file.endsWith('.js'))
            .map(async file => await import(file) as SimpleCommand)
        )).map(c => (c as any).default)

    client.on('message/update', async msg => {
        checkCustomRules(msg, true);
    });

    client.on('message', async msg => {
        logger.debug(`Message -> ${msg.content}`);

        if (typeof msg.content != 'string' ||
            msg.author_id == client.user?._id ||
            !msg.channel?.server) return;

        try {
            if (!msg.member) await msg.channel.server.fetchMember(msg.author_id);
            if (!msg.author) await client.users.fetch(msg.author_id);
        } catch(e) {
            return msg.reply('⚠ Failed to fetch message author');
        }

        if (msg.author!.bot) return;

        // If we can't reply to the message, return
        if (!hasPermForChannel(await getOwnMemberInServer(msg.channel.server), msg.channel, 'SendMessage')) {
            logger.debug('Cannot reply to message; returning');
            return;
        }

        // Send message through anti spam check and custom rules
        if (!await antispam(msg)) return;
        checkCustomRules(msg);

        let [ config, userConfig ] = await Promise.all([
            dbs.SERVERS.findOne({ id: msg.channel!.server_id! }),
            dbs.USERS.findOne({ id: msg.author_id }),
        ]);

        if (userConfig?.ignore) return;

        let args = msg.content.split(' ');
        let cmdName = args.shift() ?? '';
        let guildPrefix = config?.prefix ?? DEFAULT_PREFIX;

        if (cmdName.startsWith(`<@${client.user?._id}>`)) {
            cmdName = cmdName.substring(`<@${client.user?._id}>`.length);
            if (!cmdName) cmdName = args.shift() ?? ''; // Space between mention and command name
        } else if (cmdName.startsWith(guildPrefix)) {
            cmdName = cmdName.substring(guildPrefix.length);
            if (config?.spaceAfterPrefix && !cmdName) cmdName = args.shift() ?? '';
        } else return;

        if (!cmdName) return;

        let cmd = commands.find(c => c.name == cmdName || (c.aliases?.indexOf(cmdName!) ?? -1) > -1);
        if (!cmd) {
            // lil easter egg

            const cmds = [
                'apt', 'pacman', 'visudo', 'apk', 'cat', 'shutdown', 'reboot',
            ];
            if (msg.author && guildPrefix == 'sudo' && config?.spaceAfterPrefix) {
                if (cmds.includes(cmdName)) {
                    await msg.reply(`${msg.author.username} is not in the sudoers file. This incident will be reported`);
                }
                else if (cmdName == 'echo') {
                    await msg.reply(`What kind of monster runs echo as root?`);
                }
            }

            return;
        }

        metrics.commands.inc({ command: cmd.name });

        if (isSudo(msg.author!)) updateSudoTimeout(msg.author!);

        if (cmd.restrict == 'BOTOWNER' && ownerIDs.indexOf(msg.author_id) == -1) {
            logger.warn(`User ${msg.author?.username} tried to run owner-only command: ${cmdName}`);
            msg.reply('🔒 Access denied');
            return;
        }

        let serverCtx = msg.channel?.server;

        if (config?.linkedServer) {
            try {
                serverCtx = client.servers.get(config.linkedServer)
                    || await client.servers.fetch(config.linkedServer);
            } catch(e) {
                msg.reply(`# Error\n` +
                          `Failed to fetch linked server. This command will be executed in the context of this server.\n\n` +
                          `Error: \`\`\`js\n${e}\n\`\`\``);
            }
        }

        let message: MessageCommandContext = msg as MessageCommandContext;
        message.serverContext = serverCtx;

        logger.info(`Command: ${message.author?.username} (${message.author?._id}) in ${message.channel?.server?.name} (${message.channel?.server?._id}): ${message.content}`);

        // Create document for server in DB, if not already present
        if (JSON.stringify(config) == '{}' || !config) await dbs.SERVERS.insert({ id: message.channel!.server_id! });

        if (cmd.removeEmptyArgs !== false) {
            args = args.filter(a => a.length > 0);
        }

        try {
            await cmd.run(message, args, config);
        } catch(e) {
            console.error(e);
            message.reply(`### An error has occurred:\n\`\`\`js\n${e}\n\`\`\``);
        }
    });
})();

function dirTreeSync(dir: string): string[] {
    const paths: string[] = [];

    const files = fs.readdirSync(dir, { withFileTypes: true });
    for (const file of files) {
        if (file.isDirectory()) {
            paths.push(...dirTreeSync(path.join(dir, file.name)));
        } else if (file.isFile()) {
            paths.push(path.join(dir, file.name));
        }
    }

    return paths;
}

export { DEFAULT_PREFIX, commands, ownerIDs }
